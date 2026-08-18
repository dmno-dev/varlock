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

/** Signing schemes supported by the `transform=` option on a `@proxy` rule. */
export const PROXY_TRANSFORM_SCHEMES = ['hmac-sha256', 'hmac-sha512', 'aws-sigv4'] as const;
export type ProxyTransformScheme = (typeof PROXY_TRANSFORM_SCHEMES)[number];

/**
 * Which options each scheme accepts, beyond the common ones (`scheme`,
 * `secretKey`). Adding a transform scheme = adding an entry here (validation
 * follows automatically), a member to the `ProxyRuleTransform` union, and a
 * signer dispatch in the runtime. Option *value* semantics (enums, header
 * names) are shared across schemes and validated per-option below.
 */
export const PROXY_TRANSFORM_COMMON_OPTIONS = ['scheme', 'secretKey'] as const;
const HMAC_SCHEME_SPEC = {
  requiredOptions: ['stringToSign', 'signatureHeader'],
  optionalOptions: ['keyId', 'keyHeader', 'timestampHeader', 'encoding', 'keyEncoding', 'timestampFormat'],
} as const;
export const PROXY_TRANSFORM_SCHEME_SPECS: Record<ProxyTransformScheme, {
  requiredOptions: ReadonlyArray<string>;
  optionalOptions: ReadonlyArray<string>;
}> = {
  'hmac-sha256': HMAC_SCHEME_SPEC,
  'hmac-sha512': HMAC_SCHEME_SPEC,
  // keyId = the AWS access key id item (sent in the Credential scope);
  // region/service are parsed from the inbound placeholder-signed request, so
  // they need no config - the allowlists optionally gate what we'll sign for.
  'aws-sigv4': {
    requiredOptions: ['keyId'],
    optionalOptions: ['sessionToken', 'allowedRegions', 'allowedServices'],
  },
};

export const PROXY_TRANSFORM_ENCODINGS = ['base64', 'hex'] as const;
export type ProxyTransformEncoding = (typeof PROXY_TRANSFORM_ENCODINGS)[number];

export const PROXY_TRANSFORM_KEY_ENCODINGS = ['raw', 'base64', 'hex'] as const;
export type ProxyTransformKeyEncoding = (typeof PROXY_TRANSFORM_KEY_ENCODINGS)[number];

export const PROXY_TRANSFORM_TIMESTAMP_FORMATS = ['unix-seconds', 'unix-millis', 'unix-nanos', 'rfc3339'] as const;
export type ProxyTransformTimestampFormat = (typeof PROXY_TRANSFORM_TIMESTAMP_FORMATS)[number];

/**
 * Fields available inside a `stringToSign` template, written as `{field}`.
 * All are taken from the final outbound request (after placeholder substitution),
 * so the signature covers exactly the bytes the upstream receives.
 */
export const PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS = ['timestamp', 'method', 'path', 'pathWithQuery', 'query', 'host', 'body'] as const;

/**
 * The generic HMAC transform config: sign a templated message with the secret,
 * write the signature (plus optional key id and timestamp) into headers.
 */
export type ProxyRuleHmacTransform = {
  scheme: 'hmac-sha256' | 'hmac-sha512';
  /** Item key whose real value is the HMAC key. Consumed, never substituted. */
  secretKey: string;
  /** Template over `PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS`, e.g. `{timestamp}{method}{path}{body}`. */
  stringToSign: string;
  /** Header the computed signature is written to. */
  signatureHeader: string;
  /** Optional companion item (an API key id) written to `keyHeader`. Wire-visible, substituted normally too. */
  keyId?: string;
  keyHeader?: string;
  /** Header the signing timestamp is written to (most HMAC schemes require it). */
  timestampHeader?: string;
  /** Signature output encoding. Default `base64`. */
  encoding?: ProxyTransformEncoding;
  /** How the secret is decoded into HMAC key bytes. Default `raw` (utf8). */
  keyEncoding?: ProxyTransformKeyEncoding;
  /** Timestamp format used in the template and `timestampHeader`. Default `unix-seconds`. */
  timestampFormat?: ProxyTransformTimestampFormat;
};

/**
 * The AWS SigV4 re-signing transform config. The client (an AWS SDK) signs
 * normally with *placeholder* credentials; the proxy parses region and service
 * out of the inbound credential scope, strips the placeholder signature, and
 * re-signs with the real keys. One rule covers every AWS service the client
 * talks to; region/service need no configuration.
 */
export type ProxyRuleAwsSigv4Transform = {
  scheme: 'aws-sigv4';
  /** Item key holding the AWS secret access key. Consumed, never substituted. */
  secretKey: string;
  /** Item key holding the AWS access key id (sent in the Credential scope). */
  keyId: string;
  /** Item key holding a session token (temporary credentials), sent as X-Amz-Security-Token. */
  sessionToken?: string;
  /** Only sign requests whose inbound scope names one of these regions. Omitted = any. */
  allowedRegions?: Array<string>;
  /** Only sign requests whose inbound scope names one of these services. Omitted = any. */
  allowedServices?: Array<string>;
};

/**
 * A request transform on a `@proxy` rule: the proxy computes a value (an HMAC
 * or AWS SigV4 signature) over the outbound request with a secret the child
 * never holds, and writes it into designated headers before forwarding. The
 * `secretKey` item is *consumed* by the transform - unlike a substituted
 * credential, its real value never appears anywhere in the request.
 *
 * A discriminated union on `scheme`; future schemes add a member here and a
 * spec entry in `PROXY_TRANSFORM_SCHEME_SPECS`.
 */
export type ProxyRuleTransform = ProxyRuleHmacTransform | ProxyRuleAwsSigv4Transform;

/** Every option name any scheme accepts - the key universe when `scheme` isn't statically known. */
const ALL_TRANSFORM_OPTIONS: ReadonlyArray<string> = [
  ...new Set([
    ...PROXY_TRANSFORM_COMMON_OPTIONS,
    ...Object.values(PROXY_TRANSFORM_SCHEME_SPECS)
      .flatMap((spec) => [...spec.requiredOptions, ...spec.optionalOptions]),
  ]),
];

/** RFC 7230 header-name token. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Validate a resolved `transform={...}` config object. Returns an error message
 * or undefined. Shared by the static (load-time) and resolve-time validators;
 * `partial` skips required-field and cross-field checks so the static pass can
 * validate just the entries that are literal (dynamic ones re-check at resolve
 * time). Placement-specific requirements (`secretKey` on detached rules) are
 * enforced where rules are built, not here.
 */
export function validateProxyTransformConfig(
  obj: Record<string, unknown>,
  opts?: { partial?: boolean },
): string | undefined {
  // Scheme first - it decides which other options are valid. When it isn't
  // statically known (dynamic value in the partial pass), fall back to the
  // union of every scheme's options so obvious typos still fail loudly.
  const scheme = typeof obj.scheme === 'string' && obj.scheme in PROXY_TRANSFORM_SCHEME_SPECS
    ? (obj.scheme as ProxyTransformScheme)
    : undefined;
  if (obj.scheme !== undefined && scheme === undefined) {
    return `transform.scheme must be one of ${PROXY_TRANSFORM_SCHEMES.join(', ')}`;
  }
  const spec = scheme ? PROXY_TRANSFORM_SCHEME_SPECS[scheme] : undefined;
  const validKeys = spec
    ? [...PROXY_TRANSFORM_COMMON_OPTIONS, ...spec.requiredOptions, ...spec.optionalOptions]
    : ALL_TRANSFORM_OPTIONS;
  for (const key of Object.keys(obj)) {
    if (!validKeys.includes(key)) {
      return `unknown transform option "${key}"${scheme ? ` for scheme "${scheme}"` : ''}. Valid options: ${validKeys.join(', ')}`;
    }
  }
  const checkEnum = (key: string, allowed: ReadonlyArray<string>) => {
    const val = obj[key];
    if (val === undefined) return undefined;
    if (typeof val !== 'string' || !allowed.includes(val)) {
      return `transform.${key} must be one of ${allowed.join(', ')}`;
    }
    return undefined;
  };
  const checkString = (key: string) => {
    const val = obj[key];
    if (val === undefined) return undefined;
    if (typeof val !== 'string' || !val.trim()) return `transform.${key} must be a non-empty string`;
    return undefined;
  };
  const checkHeaderName = (key: string) => {
    const val = obj[key];
    if (val === undefined) return undefined;
    if (typeof val !== 'string' || !HEADER_NAME_RE.test(val)) {
      return `transform.${key} must be a valid header name (letters, digits, and - _ . only)`;
    }
    return undefined;
  };
  // Accepts a single string or an array of non-empty strings (like domain/method).
  const checkStringList = (key: string) => {
    const val = obj[key];
    if (val === undefined) return undefined;
    const entries = Array.isArray(val) ? val : [val];
    if (!entries.length || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      return `transform.${key} must be one or more non-empty strings, e.g. ${key}=[us-east-1]`;
    }
    return undefined;
  };

  const err = checkString('stringToSign')
    ?? checkHeaderName('signatureHeader')
    ?? checkHeaderName('keyHeader')
    ?? checkHeaderName('timestampHeader')
    ?? checkString('secretKey')
    ?? checkString('keyId')
    ?? checkString('sessionToken')
    ?? checkStringList('allowedRegions')
    ?? checkStringList('allowedServices')
    ?? checkEnum('encoding', PROXY_TRANSFORM_ENCODINGS)
    ?? checkEnum('keyEncoding', PROXY_TRANSFORM_KEY_ENCODINGS)
    ?? checkEnum('timestampFormat', PROXY_TRANSFORM_TIMESTAMP_FORMATS);
  if (err) return err;

  if (typeof obj.stringToSign === 'string') {
    for (const match of obj.stringToSign.matchAll(/\{([^{}]*)\}/g)) {
      if (!PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS.includes(match[1] as any)) {
        return `transform.stringToSign contains unknown field {${match[1]}}. Valid fields: ${PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS.map((f) => `{${f}}`).join(' ')}`;
      }
    }
  }

  if (!opts?.partial) {
    if (scheme === undefined) return 'transform.scheme is required (e.g. scheme="hmac-sha256")';
    for (const required of PROXY_TRANSFORM_SCHEME_SPECS[scheme].requiredOptions) {
      if (obj[required] === undefined) {
        return `transform.${required} is required for scheme "${scheme}"`;
      }
    }
    // hmac-only pairing: the key id only travels if a header is named for it.
    // (For aws-sigv4, keyId is required alone - it lands in the Credential scope.)
    const schemeAllowsKeyHeader = PROXY_TRANSFORM_SCHEME_SPECS[scheme].optionalOptions.includes('keyHeader');
    if (schemeAllowsKeyHeader && (obj.keyId === undefined) !== (obj.keyHeader === undefined)) {
      return 'transform.keyId and transform.keyHeader must be set together (the key id item and the header it is written to)';
    }
  }
  return undefined;
}

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
  /**
   * Request transform (signing): the proxy computes a signature over the final
   * outbound request and writes it into headers before forwarding. Applies to
   * every request this rule matches; `substituteIn`/`maxOccurrences` do not
   * govern it (the computed value is not a placeholder swap, and the signing
   * secret never appears on the wire at all).
   */
  transform?: ProxyRuleTransform;
};

export type ProxyManagedItem = {
  key: string;
  placeholder: string;
  realValue: string;
  /** True when the placeholder is the generic format-agnostic fallback (may fail SDK key-format checks). */
  placeholderIsGenericFallback?: boolean;
};
