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
 * guessed at: encoded path separators, backslashes, control characters, a `#`
 * (some upstreams cut the path there as a fragment, others route on it), and
 * `..` climbing above the root.
 *
 * `;` path parameters are the one spelling with two legitimate routed forms:
 * servlet containers strip `;...` from every segment before mapping, so
 * `/v1/admin;jsessionid=x/data` routes as `/v1/admin/data` there and as the
 * literal text everywhere else. Rather than refuse them, the canonical target
 * carries both forms (`routedPaths`) and policy requires the request to be
 * authorized under every one of them (see `ruleMatchesFacts`).
 */

export type CanonicalRequestTarget = {
  /** Canonical path only (no query), e.g. `/v1/customers/42`. */
  pathOnly: string;
  /** Canonical path plus the original query string (if any). */
  requestTarget: string;
  /**
   * Other paths an upstream may route this request as. Today that is the
   * servlet form with every `;...` path parameter stripped, present only when
   * it differs from `pathOnly`. Policy must hold for `pathOnly` and all of these.
   */
  routedPaths: Array<string>;
};

export type CanonicalizeResult = | ({ ok: true } & CanonicalRequestTarget)
  | { ok: false; reason: string };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Percent-decode unreserved characters (RFC 3986 2.3) and uppercase the hex of
 * every other escape, so equivalent encodings compare equal. Returns undefined
 * on a malformed escape, or when the escape decodes to a character that would
 * change the path structure (`/`, `\`, `;`) or a control character.
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
    if (decoded === '/' || decoded === '\\' || decoded === ';') return undefined;
    if (code < 0x20 || code === 0x7f) return undefined;
    out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
    i += 2;
  }
  return out;
}

/**
 * Resolve `.`/`..`, drop empty segments, and keep a trailing slash. Segments
 * arrive already percent-normalized. Returns undefined when `..` climbs above
 * the root.
 */
function resolveSegments(segments: Array<string>, trailingSlash: boolean): string | undefined {
  const out: Array<string> = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  // Preserve a trailing slash: `/a/` and `/a` are different resources to most
  // routers, and a `**` glob does not care either way.
  return `/${out.join('/')}${trailingSlash && out.length > 0 ? '/' : ''}`;
}

/**
 * Canonicalize an origin-form request target (`/path?query`).
 *
 * - Requires origin form: the target must start with `/` (or be `*`, the
 *   asterisk-form used by `OPTIONS *`). Absolute-form inside a tunnel is
 *   rejected so the request-line authority can never disagree with `Host`.
 * - Rejects raw control characters, whitespace, backslashes, and `#` anywhere
 *   in the path. A fragment never belongs on the wire, and upstreams disagree
 *   on whether `#` ends the path (Go, nginx) or is part of it, so there is no
 *   single routed form to match against.
 * - Rejects escapes that decode to `/`, `\`, `;`, or a control character, and
 *   malformed escapes.
 * - Decodes unreserved percent-escapes and uppercases the rest.
 * - Resolves `.` and `..` segments; `..` above the root is rejected.
 * - Collapses empty segments (`//`).
 * - Keeps `;` path parameters in `pathOnly` (that is what goes upstream) and
 *   reports the servlet-stripped form in `routedPaths` when it differs, so
 *   `..;/` and `;x/` are seen for the dot and empty segments they become there.
 *
 * The query string is passed through untouched: rules never match on it, and
 * upstreams do not normalize it.
 */
export function canonicalizeRequestTarget(rawTarget: string): CanonicalizeResult {
  if (rawTarget === '*') {
    return {
      ok: true, pathOnly: '*', requestTarget: '*', routedPaths: [],
    };
  }
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
  if (rawPath.includes('#')) {
    return { ok: false, reason: 'request path contains a fragment marker ("#")' };
  }

  const segments: Array<string> = [];
  for (const rawSegment of rawPath.split('/').slice(1)) {
    const segment = normalizePercentEncoding(rawSegment);
    if (segment === undefined) {
      return { ok: false, reason: 'request path contains a malformed or disallowed percent-encoding' };
    }
    segments.push(segment);
  }

  const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/');
  const pathOnly = resolveSegments(segments, trailingSlash);
  if (pathOnly === undefined) return { ok: false, reason: 'request path climbs above the root' };

  const routedPaths: Array<string> = [];
  if (rawPath.includes(';')) {
    const stripped = resolveSegments(segments.map((s) => s.split(';')[0]!), trailingSlash);
    if (stripped === undefined) {
      return { ok: false, reason: 'request path climbs above the root once ";" path parameters are stripped' };
    }
    if (stripped !== pathOnly) routedPaths.push(stripped);
  }

  return {
    ok: true, pathOnly, requestTarget: `${pathOnly}${query}`, routedPaths,
  };
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * Whether substituting a real value into a canonical path left its structure
 * intact. Policy was evaluated on the placeholder-form path, so the value that
 * replaces the placeholder must stay inside its segment: it may not add or
 * remove segments (`/`, `..`), start a query (`?`), introduce a `;` (a servlet
 * router strips the rest of the segment, so `/v1/admin<ph>/data` with the
 * value `;x` would route as `/v1/admin/data`, a path the rules never saw), or
 * spell anything the canonicalizer would rewrite or reject. Otherwise the
 * routed path is not the one the rules authorized.
 */
export function substitutedPathKeepsStructure(canonicalPath: string, substitutedPath: string): boolean {
  if (substitutedPath === canonicalPath) return true;
  if (substitutedPath.includes('?')) return false;
  if (count(substitutedPath, ';') !== count(canonicalPath, ';')) return false;
  const check = canonicalizeRequestTarget(substitutedPath);
  if (!check.ok || check.pathOnly !== substitutedPath) return false;
  const expected = count(canonicalPath, '/');
  return [check.pathOnly, ...check.routedPaths].every((p) => count(p, '/') === expected);
}
