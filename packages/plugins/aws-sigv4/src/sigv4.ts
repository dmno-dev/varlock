import crypto from 'node:crypto';

import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { ProxyTransformSignInput, ProxyTransformSignResult, ProxyTransformSigner } from 'varlock/plugin-lib';

/**
 * AWS SigV4 re-signing (`transform={scheme="aws-sigv4"}` on a `@proxy` rule).
 *
 * The client (an AWS SDK) signs normally with *placeholder* credentials and
 * whatever region/service it cares about. We parse the region and service out
 * of the inbound credential scope (`Credential=KEY/DATE/REGION/SERVICE/
 * aws4_request`), strip the placeholder signature headers, and re-sign the
 * final outbound request with the real keys via the official AWS SDK v3 signer
 * (`@smithy/signature-v4`) - hand-rolling SigV4 canonicalization (S3 path
 * encoding in particular) is a known bug farm. One rule covers every AWS
 * service the client talks to, with optional region/service allowlists as a
 * policy gate.
 */

const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * The literal placeholder AWS accepts in lieu of a real payload hash (S3
 * streaming uploads etc.). If the client signed with it, we preserve it.
 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * Headers the re-signer rewrites. The inbound values were produced with
 * placeholder credentials; leaving any of them in place would either leak the
 * placeholder scope or corrupt the fresh canonical request.
 */
export const AWS_SIGV4_STRIP_HEADERS = ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'];

/** The shape of this scheme's validated transform config. */
export type AwsSigv4TransformOptions = {
  scheme: 'aws-sigv4';
  secretKey: string;
  keyId: string;
  sessionToken?: string;
  allowedRegions?: Array<string>;
  allowedServices?: Array<string>;
};

function toBuffer(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/** node:crypto-backed sha256 for the smithy signer (avoids the slow pure-JS @aws-crypto impl). */
export class NodeSha256 {
  private hash: crypto.Hmac | crypto.Hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash = secret !== undefined
      ? crypto.createHmac('sha256', toBuffer(secret))
      : crypto.createHash('sha256');
  }

  update(toHash: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(toBuffer(toHash));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(this.hash.digest());
  }
}

export type Sigv4Scope = { region: string; service: string };

export type ParsedSigv4Scope = | { ok: true; scope: Sigv4Scope }
  | { ok: false; error: string; presigned?: boolean };

/** Parse `ACCESSKEY/DATE/REGION/SERVICE/aws4_request`. */
function parseCredentialPath(credential: string): ParsedSigv4Scope {
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request' || !parts[2] || !parts[3]) {
    return { ok: false, error: `malformed SigV4 credential scope ${JSON.stringify(credential)}` };
  }
  return { ok: true, scope: { region: parts[2], service: parts[3] } };
}

/**
 * Extract the credential scope from the inbound placeholder signature. Normal
 * SDK requests carry it in the Authorization header; a pre-signed URL carries
 * it in the `X-Amz-Credential` query param - re-signing those means rewriting
 * signed query params, which we don't support yet, so it gets a distinct error.
 */
export function parseSigv4InboundScope(authorizationHeader: string | undefined, queryString: string): ParsedSigv4Scope {
  if (authorizationHeader) {
    if (!authorizationHeader.startsWith(`${SIGV4_ALGORITHM} `)) {
      return { ok: false, error: `the Authorization header is not a ${SIGV4_ALGORITHM} signature` };
    }
    const credentialPart = authorizationHeader
      .slice(SIGV4_ALGORITHM.length + 1)
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.startsWith('Credential='));
    if (!credentialPart) return { ok: false, error: 'the Authorization header has no Credential field' };
    return parseCredentialPath(credentialPart.slice('Credential='.length));
  }
  if (new URLSearchParams(queryString).get('X-Amz-Credential')) {
    return {
      ok: false,
      presigned: true,
      error: 'this looks like a pre-signed URL (X-Amz-Credential in the query), which the proxy cannot re-sign yet - use header-signed requests',
    };
  }
  return {
    ok: false,
    error: 'the request carries no SigV4 signature. Configure the AWS SDK with the placeholder credentials so it signs normally; the proxy re-signs with the real keys',
  };
}

/**
 * Re-sign one request: the scheme's `ProxyTransformSigner`. Returns the
 * replacement signature headers (and the inbound placeholder-signed headers to
 * remove) for the runtime to apply before forwarding.
 */
export const signAwsSigv4Transform: ProxyTransformSigner = async (
  transform,
  input: ProxyTransformSignInput,
  nowMs: number,
): Promise<ProxyTransformSignResult> => {
  const options = transform as unknown as AwsSigv4TransformOptions;

  const parsed = parseSigv4InboundScope(input.headers.authorization, input.query);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, status: 400 };
  }
  const { scope } = parsed;

  if (options.allowedRegions && !options.allowedRegions.includes(scope.region)) {
    return { ok: false, error: `region "${scope.region}" is not in the transform's allowedRegions`, status: 403 };
  }
  if (options.allowedServices && !options.allowedServices.includes(scope.service)) {
    return { ok: false, error: `service "${scope.service}" is not in the transform's allowedServices`, status: 403 };
  }

  // aws-chunked streaming payloads (STREAMING-AWS4-..., STREAMING-UNSIGNED-
  // PAYLOAD-TRAILER) carry per-chunk framing (and per-chunk placeholder-keyed
  // signatures) that cannot be re-signed; hashing the framed bytes instead
  // would produce an opaque upstream XAmzContentSHA256Mismatch. Fail closed
  // with a pointer at the cause. The plain UNSIGNED-PAYLOAD sentinel IS
  // preserved (no chunk framing, nothing to re-sign in the body).
  const inboundPayloadSentinel = input.headers['x-amz-content-sha256'];
  if (inboundPayloadSentinel?.startsWith('STREAMING-')) {
    return {
      ok: false,
      status: 400,
      error: `aws-chunked streaming upload (x-amz-content-sha256: ${inboundPayloadSentinel}) cannot be re-signed by the proxy - disable flexible checksums / streaming signing in the SDK (e.g. requestChecksumCalculation: "WHEN_REQUIRED") so it sends a plain signed payload`,
    };
  }
  const payloadHash = inboundPayloadSentinel === UNSIGNED_PAYLOAD
    ? UNSIGNED_PAYLOAD
    : crypto.createHash('sha256').update(input.body).digest('hex');

  const headersForSigning: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!AWS_SIGV4_STRIP_HEADERS.includes(name)) headersForSigning[name] = value;
  }
  // Setting the payload hash header explicitly (rather than letting the signer
  // infer it) makes the signed canonical request deterministic across services,
  // and S3 requires it.
  headersForSigning['x-amz-content-sha256'] = payloadHash;

  const query: Record<string, string | Array<string>> = {};
  for (const [name, value] of new URLSearchParams(input.query)) {
    const existing = query[name];
    if (existing === undefined) query[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[name] = [existing, value];
  }

  try {
    const signer = new SignatureV4({
      credentials: {
        accessKeyId: input.credentials.keyId,
        secretAccessKey: input.credentials.secretKey,
        ...(input.credentials.sessionToken !== undefined ? { sessionToken: input.credentials.sessionToken } : {}),
      },
      region: scope.region,
      service: scope.service,
      sha256: NodeSha256,
      // S3 uses single-encoded, unnormalized paths; every other service double-encodes.
      uriEscapePath: scope.service !== 's3',
      applyChecksum: false, // we set x-amz-content-sha256 ourselves above
    });
    const signed = await signer.sign(new HttpRequest({
      protocol: 'https:',
      hostname: input.host,
      method: input.method,
      path: input.path,
      query,
      headers: headersForSigning,
    }), { signingDate: new Date(nowMs) });

    const setHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(signed.headers)) {
      const lower = name.toLowerCase();
      if (AWS_SIGV4_STRIP_HEADERS.includes(lower)) setHeaders[lower] = value;
    }
    if (!setHeaders.authorization) return { ok: false, error: 'signer produced no Authorization header' };
    return { ok: true, setHeaders, removeHeaders: AWS_SIGV4_STRIP_HEADERS };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
