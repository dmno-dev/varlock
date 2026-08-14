import crypto from 'node:crypto';

import type { ProxyRuleTransform, ProxyTransformTimestampFormat } from './types';

/**
 * Request signing (the `transform=` option on a `@proxy` rule).
 *
 * The proxy computes an HMAC signature over a template derived from the final
 * outbound request - after placeholder substitution, so the signature covers
 * exactly the bytes the upstream receives - and writes it (plus an optional key
 * id and timestamp) into headers before forwarding. The signing secret is
 * consumed here and never appears in the request itself, which is a stronger
 * boundary than placeholder substitution: the child cannot produce a valid
 * signature even in principle, because it never holds the key.
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
export function decodeTransformKey(secret: string, keyEncoding: ProxyRuleTransform['keyEncoding']): Buffer | undefined {
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

const HMAC_ALGO_BY_SCHEME: Record<ProxyRuleTransform['scheme'], string> = {
  'hmac-sha256': 'sha256',
  'hmac-sha512': 'sha512',
};

/**
 * Compute the signature (and its timestamp) for one request. `nowMs` is
 * injectable for tests; callers pass `Date.now()`.
 */
export function computeHmacTransform(
  transform: ProxyRuleTransform,
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
