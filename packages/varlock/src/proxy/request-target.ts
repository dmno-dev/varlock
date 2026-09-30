/**
 * Canonicalization of the request target (path + query) before policy matching.
 *
 * `@proxy(path=...)` rules are matched against the request path, and the path
 * is also what the upstream routes on. If the two disagree, a block rule (or a
 * strict-egress allow rule) can be bypassed: `/v1/charges/../refunds/x` does
 * not match `path="/v1/refunds/**"` textually, but every upstream normalizes it
 * to `/v1/refunds/x` before routing. The same goes for `//`, `/./`, and
 * percent-encoded unreserved characters (`%72efunds`).
 *
 * So the proxy canonicalizes first, matches the canonical path, and sends the
 * canonical form upstream, so what was matched is what is routed. Anything the
 * canonical form cannot express unambiguously is rejected (400) rather than
 * guessed at: encoded path separators, backslashes, control characters, dot
 * segments hidden behind `;` path parameters, and `..` climbing above the root.
 */

export type CanonicalRequestTarget = {
  /** Canonical path only (no query), e.g. `/v1/customers/42`. */
  pathOnly: string;
  /** Canonical path plus the original query string (if any). */
  requestTarget: string;
};

export type CanonicalizeResult = | ({ ok: true } & CanonicalRequestTarget)
  | { ok: false; reason: string };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Percent-decode unreserved characters (RFC 3986 2.3) and uppercase the hex of
 * every other escape, so equivalent encodings compare equal. Returns undefined
 * on a malformed escape, or when the escape decodes to a character that would
 * change the path structure (`/`, `\`) or a control character.
 */
function normalizePercentEncoding(segment: string): string | undefined {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const hex = segment.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
    const code = parseInt(hex, 16);
    const decoded = String.fromCharCode(code);
    if (decoded === '/' || decoded === '\\') return undefined;
    if (code < 0x20 || code === 0x7f) return undefined;
    out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
    i += 2;
  }
  return out;
}

/**
 * Canonicalize an origin-form request target (`/path?query`).
 *
 * - Requires origin form: the target must start with `/` (or be `*`, the
 *   asterisk-form used by `OPTIONS *`). Absolute-form inside a tunnel is
 *   rejected so the request-line authority can never disagree with `Host`.
 * - Rejects raw control characters, whitespace, and backslashes anywhere in the path.
 * - Rejects escapes that decode to `/`, `\`, or a control character, and
 *   malformed escapes.
 * - Decodes unreserved percent-escapes and uppercases the rest.
 * - Resolves `.` and `..` segments; `..` above the root is rejected.
 * - Rejects a segment whose part before a `;` path parameter is `.` or `..`
 *   (servlet containers strip the parameter, then normalize).
 * - Collapses empty segments (`//`).
 *
 * The query string is passed through untouched: rules never match on it, and
 * upstreams do not normalize it.
 */
export function canonicalizeRequestTarget(rawTarget: string): CanonicalizeResult {
  if (rawTarget === '*') return { ok: true, pathOnly: '*', requestTarget: '*' };
  if (!rawTarget.startsWith('/')) {
    return { ok: false, reason: 'request target must be in origin form (start with "/")' };
  }

  const queryStart = rawTarget.indexOf('?');
  const rawPath = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawTarget.slice(queryStart);

  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\x00-\x20\x7f\\]/.test(rawPath)) {
    return { ok: false, reason: 'request path contains a control character, whitespace, or backslash' };
  }

  const segments: Array<string> = [];
  for (const rawSegment of rawPath.split('/').slice(1)) {
    const segment = normalizePercentEncoding(rawSegment);
    if (segment === undefined) {
      return { ok: false, reason: 'request path contains a malformed or disallowed percent-encoding' };
    }
    if (segment === '') continue; // `//` or trailing `/`
    if (segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { ok: false, reason: 'request path climbs above the root' };
      segments.pop();
      continue;
    }
    const beforeParams = segment.split(';')[0];
    if (beforeParams === '.' || beforeParams === '..') {
      return { ok: false, reason: 'request path hides a dot segment behind a path parameter' };
    }
    segments.push(segment);
  }

  // Preserve a trailing slash: `/a/` and `/a` are different resources to most
  // routers, and a `**` glob does not care either way.
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/') && segments.length > 0;
  const pathOnly = `/${segments.join('/')}${trailingSlash ? '/' : ''}`;
  return { ok: true, pathOnly, requestTarget: `${pathOnly}${query}` };
}
