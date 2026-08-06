import { replaceRealWithPlaceholders } from './substitution';
import type { ProxyManagedItem } from './types';

/**
 * A header map in node's incoming shape (lower-cased names; repeated headers as
 * arrays). Structurally compatible with `http.IncomingHttpHeaders`, but defined
 * here so nothing in the core depends on node types. Adapters for other
 * transports (e.g. a fetch-based gateway) convert their native headers into
 * this shape.
 */
export type HeadersRecord = Record<string, string | Array<string> | undefined>;

export type HeaderTransformFn = (value: string) => string;

export function transformHeaders(
  headers: HeadersRecord,
  transformValue: HeaderTransformFn,
): Record<string, string | Array<string>> {
  const out: Record<string, string | Array<string>> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      out[key] = val.map((v) => transformValue(v));
    } else {
      out[key] = transformValue(String(val));
    }
  }
  return out;
}

export function getHeaderValue(
  headers: HeadersRecord,
  key: string,
): string | undefined {
  const raw = headers[key.toLowerCase()];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return String(raw);
}

export function isUncompressedResponse(headers: HeadersRecord): boolean {
  const contentEncoding = getHeaderValue(headers, 'content-encoding');
  if (!contentEncoding) return true;
  const tokens = contentEncoding.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((token) => token === 'identity');
}

export function isTextLikeResponse(headers: HeadersRecord): boolean {
  const contentType = getHeaderValue(headers, 'content-type')?.toLowerCase();
  if (!contentType) return false;
  return contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('xml')
    || contentType.includes('javascript')
    || contentType.includes('x-www-form-urlencoded')
    || contentType.includes('graphql');
}

// Only buffer-and-redact bounded, reasonably small text bodies. Anything we
// can't size up front (SSE, chunked streams) or that's too large is streamed
// straight through — buffering it would break streaming (e.g. LLM token-by-token
// responses hang until complete) for a low-value protection: the injected secret
// is in the request, not the response. Header redaction still applies regardless.
export const MAX_REDACT_BODY_BYTES = 2 * 1024 * 1024;

export function isStreamingResponse(headers: HeadersRecord): boolean {
  const contentType = getHeaderValue(headers, 'content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/event-stream');
}

export function isBoundedRedactableBody(headers: HeadersRecord): boolean {
  const lenRaw = getHeaderValue(headers, 'content-length');
  if (lenRaw === undefined) return false; // unknown size — treat as a stream, never buffer
  const len = Number(lenRaw);
  return Number.isFinite(len) && len >= 0 && len <= MAX_REDACT_BODY_BYTES;
}

export function shouldRedactResponseBody(headers: HeadersRecord): boolean {
  return isUncompressedResponse(headers)
    && isTextLikeResponse(headers)
    && !isStreamingResponse(headers)
    && isBoundedRedactableBody(headers);
}

export function redactOutgoingHeaders(
  headers: HeadersRecord,
  managedItems: Array<ProxyManagedItem>,
): Record<string, string | Array<string>> {
  return transformHeaders(
    headers,
    (value) => replaceRealWithPlaceholders(value, managedItems),
  );
}
