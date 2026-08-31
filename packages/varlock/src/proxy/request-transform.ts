import crypto from 'node:crypto';

import {
  BUILT_IN_TRANSFORM_SCHEME_SPECS,
  type ProxyRuleHmacTransform, type ProxyTransformSchemeDef,
  type ProxyTransformSigner, type ProxyTransformTimestampFormat,
} from './types';

/**
 * Request signing (the `transform=` option on a `@proxy` rule).
 *
 * A signer turns the final outbound request - after placeholder substitution,
 * so it covers exactly the bytes the upstream receives - plus the real
 * credentials into request headers. The hmac schemes send only a derived
 * signature, so the secret never leaves the proxy; http-basic sends the
 * credentials themselves, base64-encoded, because that is what Basic auth is.
 * Either way the credential is consumed here rather than substituted, so the
 * child cannot produce a valid request itself: it never holds the value.
 *
 * Everything in this file is pure (time injected) so it can be tested with
 * fixed vectors.
 */

/** Fields of the outbound request a `stringToSign` template can reference. */
export type TransformRequestFields = {
  method: string;
  host: string;
  /** URL path only, no query string. Post-substitution. */
  path: string;
  /** Raw query string without the leading `?`. Post-substitution. */
  query: string;
  /** Request body as utf8 text. Post-substitution. */
  body: string;
};

export type TransformResult = | { ok: true; signature: string; timestamp: string }
  | { ok: false; error: string };

export function computeTransformTimestamp(format: ProxyTransformTimestampFormat | undefined, nowMs: number): string {
  switch (format) {
    case undefined:
    case 'unix-seconds': return String(Math.floor(nowMs / 1000));
    case 'unix-millis': return String(Math.floor(nowMs));
    case 'unix-nanos': return `${Math.floor(nowMs)}000000`;
    case 'rfc3339': return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    default: {
      // Exhaustiveness backstop - config validation rejects unknown formats.
      const exhaustiveCheck: never = format;
      throw new Error(`unknown timestamp format ${exhaustiveCheck as string}`);
    }
  }
}

/** Expand a `stringToSign` template. Unknown `{field}`s are rejected at schema load. */
export function buildStringToSign(template: string, fields: TransformRequestFields & { timestamp: string }): string {
  const pathWithQuery = fields.query ? `${fields.path}?${fields.query}` : fields.path;
  const values: Record<string, string> = {
    timestamp: fields.timestamp,
    method: fields.method,
    path: fields.path,
    pathWithQuery,
    query: fields.query,
    host: fields.host,
    body: fields.body,
  };
  return template.replace(/\{([^{}]*)\}/g, (match, name) => (name in values ? values[name] : match));
}

/**
 * Decode the secret into HMAC key bytes per `keyEncoding`. Returns undefined on
 * a malformed encoded key (fail closed - a silently-wrong key would sign every
 * request invalidly, which is much harder to debug upstream).
 */
export function decodeTransformKey(secret: string, keyEncoding: ProxyRuleHmacTransform['keyEncoding']): Buffer | undefined {
  switch (keyEncoding) {
    case undefined:
    case 'raw': return Buffer.from(secret, 'utf8');
    case 'hex': {
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(secret)) return undefined;
      return Buffer.from(secret, 'hex');
    }
    case 'base64': {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length % 4 !== 0) return undefined;
      return Buffer.from(secret, 'base64');
    }
    default: {
      const exhaustiveCheck: never = keyEncoding;
      throw new Error(`unknown key encoding ${exhaustiveCheck as string}`);
    }
  }
}

const HMAC_ALGO_BY_SCHEME: Record<ProxyRuleHmacTransform['scheme'], string> = {
  'hmac-sha256': 'sha256',
  'hmac-sha512': 'sha512',
};

/**
 * Compute the signature (and its timestamp) for one request. `nowMs` is
 * injectable for tests; callers pass `Date.now()`.
 */
export function computeHmacTransform(
  transform: ProxyRuleHmacTransform,
  secretValue: string,
  fields: TransformRequestFields,
  nowMs: number,
): TransformResult {
  const key = decodeTransformKey(secretValue, transform.keyEncoding);
  if (key === undefined) {
    return { ok: false, error: `the signing secret is not valid ${transform.keyEncoding} (per transform.keyEncoding)` };
  }
  const timestamp = computeTransformTimestamp(transform.timestampFormat, nowMs);
  const stringToSign = buildStringToSign(transform.stringToSign, { ...fields, timestamp });
  const digest = crypto.createHmac(HMAC_ALGO_BY_SCHEME[transform.scheme], key)
    .update(stringToSign, 'utf8')
    .digest();
  const signature = transform.encoding === 'hex' ? digest.toString('hex') : digest.toString('base64');
  return { ok: true, signature, timestamp };
}

/**
 * The hmac schemes' signer, adapted to the generic `ProxyTransformSigner`
 * interface. HMAC string-to-sign templates are inherently text, so `{body}`
 * covers the body as utf8 text (venue HMAC APIs sign JSON/form bodies; the
 * outbound bytes themselves are preserved separately by the runtime).
 */
const signHmacTransform: ProxyTransformSigner = (transform, input, nowMs) => {
  const hmacTransform = transform as unknown as ProxyRuleHmacTransform;
  const result = computeHmacTransform(hmacTransform, input.credentials.secretKey, {
    method: input.method,
    host: input.host,
    path: input.path,
    query: input.query,
    body: input.body.toString('utf8'),
  }, nowMs);
  if (!result.ok) return { ok: false, error: result.error };
  const setHeaders: Record<string, string> = {
    [hmacTransform.signatureHeader.toLowerCase()]: result.signature,
  };
  if (hmacTransform.timestampHeader) setHeaders[hmacTransform.timestampHeader.toLowerCase()] = result.timestamp;
  if (hmacTransform.keyHeader && input.credentials.keyId !== undefined) {
    setHeaders[hmacTransform.keyHeader.toLowerCase()] = input.credentials.keyId;
  }
  return { ok: true, setHeaders };
};

/**
 * The HTTP Basic signer: writes `Authorization: Basic base64(user:password)`
 * with the REAL values, overwriting whatever the child sent (its own header
 * encodes a placeholder, which base64 hides from substitution entirely).
 * Either side may be the credential, so this covers a secret password, a
 * token-as-userid (`curl -u "token:"`), and both-sides-secret alike.
 */
const signHttpBasicTransform: ProxyTransformSigner = (transform, input) => {
  // Both sides are item references, resolved by the runtime into credentials
  // under the same option names. An unset side is empty.
  const userid = input.credentials.username ?? '';
  const password = input.credentials.password ?? '';
  // RFC 7617: a colon in the userid would shift the user/password split.
  if (userid.includes(':')) {
    return { ok: false, error: 'the Basic auth username contains ":", which is not allowed (it separates username from password)' };
  }
  const token = Buffer.from(`${userid}:${password}`, 'utf8').toString('base64');
  // The token is a reversible encoding of the credentials, so an endpoint that
  // reflects `Authorization` would hand the child something it can decode. The
  // raw values are scrubbed by the runtime already (they are sensitive); this
  // encoded form is the part only this scheme can produce.
  return { ok: true, setHeaders: { authorization: `Basic ${token}` }, scrubFromResponse: [token] };
};

const BUILT_IN_SIGNERS: Record<string, ProxyTransformSigner> = {
  'hmac-sha256': signHmacTransform,
  'hmac-sha512': signHmacTransform,
  'http-basic': signHttpBasicTransform,
};

/**
 * The full built-in scheme registrations (spec + signer). Seeded into every
 * `EnvGraph` and used as the runtime default; plugins extend the set.
 */
export const BUILT_IN_TRANSFORM_SCHEMES: Record<string, ProxyTransformSchemeDef> = Object.fromEntries(
  Object.entries(BUILT_IN_TRANSFORM_SCHEME_SPECS)
    .map(([name, spec]) => [name, { ...spec, sign: BUILT_IN_SIGNERS[name] }]),
);
