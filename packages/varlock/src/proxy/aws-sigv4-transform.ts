import crypto from 'node:crypto';

import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

import type { ProxyRuleAwsSigv4Transform } from './types';

/**
 * AWS SigV4 re-signing (the `transform={scheme="aws-sigv4"}` option).
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
export const AWS_SIGV4_STRIP_HEADERS = ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'] as const;

function toBuffer(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/** node:crypto-backed sha256 for the smithy signer (avoids the slow pure-JS @aws-crypto impl). */
class NodeSha256 {
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

export type Sigv4TransformInput = {
  method: string;
  /** Hostname the request is addressed to (the rule host). */
  host: string;
  /** URL path only, no query string. Post-substitution. */
  path: string;
  /** Raw query string without the leading `?`. Post-substitution. */
  query: string;
  /**
   * The final outbound headers (post-substitution, hop-by-hop already removed).
   * Multi-value headers should be pre-joined with `,` (SigV4 canonical form).
   */
  headers: Record<string, string>;
  /** The exact body bytes that will be written upstream. */
  body: Buffer;
};

export type Sigv4TransformResult = | { ok: true; headers: Record<string, string>; scope: Sigv4Scope }
  | { ok: false; error: string; kind: 'missing-sigv4' | 'presigned-unsupported' | 'scope-not-allowed' | 'signing-failed' };

/**
 * Re-sign one request. Returns the replacement signature headers (lowercase
 * names) to write onto the outbound request after removing
 * `AWS_SIGV4_STRIP_HEADERS`. `nowMs` is injectable for tests.
 */
export async function computeAwsSigv4Transform(
  transform: ProxyRuleAwsSigv4Transform,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  input: Sigv4TransformInput,
  nowMs: number,
): Promise<Sigv4TransformResult> {
  const parsed = parseSigv4InboundScope(input.headers.authorization, input.query);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, kind: parsed.presigned ? 'presigned-unsupported' : 'missing-sigv4' };
  }
  const { scope } = parsed;

  if (transform.allowedRegions && !transform.allowedRegions.includes(scope.region)) {
    return { ok: false, error: `region "${scope.region}" is not in the transform's allowedRegions`, kind: 'scope-not-allowed' };
  }
  if (transform.allowedServices && !transform.allowedServices.includes(scope.service)) {
    return { ok: false, error: `service "${scope.service}" is not in the transform's allowedServices`, kind: 'scope-not-allowed' };
  }

  // Preserve an UNSIGNED-PAYLOAD sentinel the client signed with (S3 streaming
  // uploads); otherwise hash the exact outbound bytes. Setting the header
  // explicitly (rather than letting the signer infer it) makes the signed
  // canonical request deterministic across services, and S3 requires it.
  const payloadHash = input.headers['x-amz-content-sha256'] === UNSIGNED_PAYLOAD
    ? UNSIGNED_PAYLOAD
    : crypto.createHash('sha256').update(input.body).digest('hex');

  const headersForSigning: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!(AWS_SIGV4_STRIP_HEADERS as ReadonlyArray<string>).includes(name)) headersForSigning[name] = value;
  }
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
      credentials,
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

    const outHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(signed.headers)) {
      const lower = name.toLowerCase();
      if ((AWS_SIGV4_STRIP_HEADERS as ReadonlyArray<string>).includes(lower)) outHeaders[lower] = value;
    }
    if (!outHeaders.authorization) return { ok: false, error: 'signer produced no Authorization header', kind: 'signing-failed' };
    return { ok: true, headers: outHeaders, scope };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'signing-failed' };
  }
}
