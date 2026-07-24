export type ProxyEgressMode = 'permissive' | 'strict';

/**
 * Approval granularity — what a single approval (and any standing grant) covers.
 * `host` = the host; `endpoint` = method + path; `request` = method + path + body.
 */
export type ProxyApprovalEach = 'host' | 'endpoint' | 'request';

export const PROXY_APPROVAL_EACH_VALUES: ReadonlyArray<ProxyApprovalEach> = ['host', 'endpoint', 'request'];

/**
 * Which part of a request a managed item's placeholder may be substituted into: a
 * header value, the URL path, the query string, or the request body.
 */
export type ProxySubstitutionLocation = 'header' | 'path' | 'query' | 'body';

export const PROXY_SUBSTITUTION_LOCATION_VALUES: ReadonlyArray<ProxySubstitutionLocation> = ['header', 'path', 'query', 'body'];

/**
 * A specific place a placeholder is allowed to be substituted:
 *  - `{ location: 'header' }` — any request header value.
 *  - `{ location: 'header', name }` — only the named header (case-insensitive), e.g. `authorization`.
 *  - `{ location: 'path' }` — anywhere in the URL path (the part before `?`), for APIs
 *    that carry a token in the path itself, e.g. `/v1/{token}/data`.
 *  - `{ location: 'query' }` — anywhere in the query string (the part after `?`).
 *  - `{ location: 'query', name }` — only the named query parameter's value.
 *  - `{ location: 'body', path }` — only the value at the given body path (JSON dotted
 *    path or form field). Body substitution ALWAYS requires a path, since "anywhere
 *    in the body" is the easiest surface to exfiltrate from. The one exception is the
 *    explicit wildcard `path: '*'` (`body:*`), an opt-in escape hatch for bodies we
 *    can't parse into a path (XML/SOAP, protobuf, plain text); it allows the
 *    placeholder anywhere in the body, so scope the rule tightly and keep the
 *    occurrence cap low.
 */
export type ProxySubstitutionTarget = | { location: 'header'; name?: string }
  | { location: 'path' }
  | { location: 'query'; name?: string }
  | { location: 'body'; path: string };

/**
 * Default target when a rule doesn't set `substituteIn`: any header. Most API
 * secrets travel in an auth header (`Authorization`, `X-Api-Key`), and restricting
 * to headers keeps a placeholder from being swapped for the real value inside a
 * request body or query where it could be exfiltrated — e.g. a placeholder stuffed
 * into an email body on an otherwise-allowed host. Widen with a specific target
 * (`substituteIn=[header, body:client_secret]`) for APIs that carry the secret
 * elsewhere (OAuth token exchange, some legacy `?api_key=` APIs).
 */
export const DEFAULT_PROXY_SUBSTITUTION_TARGETS: ReadonlyArray<ProxySubstitutionTarget> = [{ location: 'header' }];

/** A stable key for de-duplicating / comparing targets (location + name/path). */
export function proxySubstitutionTargetKey(target: ProxySubstitutionTarget): string {
  if (target.location === 'body') return `body:${target.path}`;
  if (target.location === 'path') return 'path';
  return target.name ? `${target.location}:${target.name}` : target.location;
}

/**
 * Headers the bare `header` (any-header) default will NOT substitute into: they're
 * never a legitimate place for a managed secret and are common forward/log sinks,
 * so a placeholder landing here is almost always an attempt to redirect the one
 * allowed substitution somewhere it leaks (e.g. a header the upstream forwards to a
 * webhook). Any `x-forwarded-*` header is covered by prefix. This narrows only the
 * default — an explicit `header:<name>` target (even for one of these) still wins,
 * for the rare API that genuinely authenticates via, say, a cookie.
 */
export const PROXY_NEVER_AUTO_SUBSTITUTE_HEADERS: ReadonlyArray<string> = ['cookie', 'host', 'forwarded', 'via', 'referer', 'origin', 'user-agent'];

/** Whether the any-header default excludes this header (see `PROXY_NEVER_AUTO_SUBSTITUTE_HEADERS`). */
export function isNeverAutoSubstituteHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('x-forwarded-') || PROXY_NEVER_AUTO_SUBSTITUTE_HEADERS.includes(lower);
}

/** Result of parsing one `substituteIn` entry: the structured target, or an error message. */
export type ParsedProxySubstitutionTarget = | { ok: true; target: ProxySubstitutionTarget }
  | { ok: false; error: string };

/**
 * Parse one `substituteIn` entry (`header`, `header:authorization`, `path`,
 * `query`, `query:api_key`, `body:client_secret`) into a structured target.
 * Returns a discriminated result so both the schema validator and the runtime
 * share one grammar. Header names are lower-cased (HTTP header names are
 * case-insensitive); query params and body paths keep their case.
 */
export function parseProxySubstitutionTarget(raw: string): ParsedProxySubstitutionTarget {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(':');
  const location = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim();
  const arg = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
  const invalid = () => ({
    ok: false as const,
    error: `invalid substituteIn target ${JSON.stringify(raw)}. Valid forms: header, header:<name>, path, query, query:<param>, body:<path>`,
  });
  if (location === 'header') return { ok: true, target: arg ? { location: 'header', name: arg.toLowerCase() } : { location: 'header' } };
  if (location === 'query') return { ok: true, target: arg ? { location: 'query', name: arg } : { location: 'query' } };
  if (location === 'path') {
    if (arg) return { ok: false, error: 'substituteIn: path takes no argument (the URL path has no named segments). Use "path" on its own to allow a token anywhere in the path' };
    return { ok: true, target: { location: 'path' } };
  }
  if (location === 'body') {
    if (!arg) {
      return {
        ok: false,
        error: 'substituteIn: body substitution requires a path (e.g. body:client_secret), or body:* to allow anywhere in the body. There is no bare "body" form',
      };
    }
    return { ok: true, target: { location: 'body', path: arg } };
  }
  return invalid();
}

/**
 * Default cardinality cap when a rule doesn't set `maxOccurrences`: a placeholder
 * may appear at most once per request. A valid request uses the secret a fixed
 * number of times, so an extra occurrence is usually an exfiltration copy (the
 * secret duplicated into an attacker-visible field while a valid call is still
 * made).
 */
export const DEFAULT_PROXY_MAX_OCCURRENCES = 1;

export type ProxyRule = {
  domain: Array<string>;
  itemKeys: Array<string>;
  path?: string;
  /** Allowed HTTP methods (uppercased). Omitted = any method. */
  method?: Array<string>;
  block?: boolean;
  /**
   * Require out-of-band approval before this request is forwarded (Invariant #8).
   * Presence ⇒ required; `undefined` ⇒ no approval. Nesting the granularity here
   * makes "granularity without approval" unrepresentable.
   */
  approval?: {
    /** Granularity of approvals / standing grants. Default `endpoint`. */
    each?: ProxyApprovalEach;
    /**
     * Ceiling on how long a "yes" may be remembered, in ms — the schema-enforced
     * cap on grant lifetime. `0` = always ask (never remembered); `undefined` =
     * may persist for the whole session.
     */
    maxDurationMs?: number;
  };
  /**
   * Where this rule's injected placeholders may be substituted for the real value,
   * as raw `substituteIn` entries (`header`, `header:authorization`, `query`,
   * `query:api_key`, `body:client_secret`). Validated at schema load; parsed into
   * structured targets at request time. Omitted ⇒ `DEFAULT_PROXY_SUBSTITUTION_TARGETS`
   * (any header). A placeholder that reaches a spot no target allows is treated as
   * an anomaly and the request is blocked, rather than silently substituted.
   */
  substituteIn?: Array<string>;
  /**
   * Max times a single injected placeholder may appear in one request. Omitted ⇒
   * `DEFAULT_PROXY_MAX_OCCURRENCES` (`1`). Exceeding it blocks the request.
   */
  maxOccurrences?: number;
};

export type ProxyManagedItem = {
  key: string;
  placeholder: string;
  realValue: string;
  /** True when the placeholder is the generic format-agnostic fallback (may fail SDK key-format checks). */
  placeholderIsGenericFallback?: boolean;
};
