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

// ~ Request transforms (signing) ~

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
 * How one option of a transform scheme is typed and validated. `itemRole`
 * marks options whose value is the NAME of another env item:
 *  - `consumed`: the item's real value is used by the signer and never appears
 *    on the wire (the signing secret). Managed (placeholder in the child env),
 *    excluded from substitution, and its placeholder appearing in a request it
 *    is not injectable into fails closed.
 *  - `wire`: the item travels in the request (an API key id, a session token).
 *    Managed, and it joins the rule's substitution scope like a `keys=` entry.
 * Everything the schema/rule machinery must know about an option lives here,
 * so registering a scheme (built-in or plugin) wires validation, placeholder
 * management, and credential resolution without touching those code paths.
 */
export type ProxyTransformOptionSpec = {
  required?: boolean;
  type: 'string' | 'headerName' | 'template' | 'stringList' | 'enum';
  /** For `type: 'enum'`. */
  enumValues?: ReadonlyArray<string>;
  itemRole?: 'consumed' | 'wire';
  /**
   * For itemRole options only: also accept a plain literal value (e.g. a
   * static username) alongside the `$ITEM` reference form. Without this flag,
   * itemRole options REQUIRE the reference form.
   */
  literalAllowed?: boolean;
};

/**
 * Item-role option values are written as references (`password=$API_PASSWORD`),
 * captured pre-resolution as `$NAME` markers so the item's value never resolves
 * into rule data. Returns the bare item name when the option/value denote an
 * item reference, or undefined for a literal (only valid with `literalAllowed`).
 */
export function proxyTransformItemRefName(optionSpec: ProxyTransformOptionSpec, value: unknown): string | undefined {
  if (optionSpec.itemRole === undefined || typeof value !== 'string') return undefined;
  if (value.startsWith('$')) return value.slice(1);
  // canonicalized rule data stores bare names for ref-only options
  return optionSpec.literalAllowed ? undefined : value;
}

/**
 * A transform scheme's declaration: its option specs plus an optional
 * cross-field validation hook (run at resolve time, after per-option checks).
 * The common options (`scheme` itself, and `secretKey` = the consumed signing
 * secret, defaulting to the decorated item on attached rules) are implied and
 * not repeated per scheme.
 */
export type ProxyTransformSchemeSpec = {
  options: Record<string, ProxyTransformOptionSpec>;
  validate?: (config: Record<string, unknown>) => string | undefined;
  /**
   * Place an ATTACHED rule's decorated item into the config, as a `$NAME`
   * reference. Defaults to filling the scheme's single consumed option when it
   * is unset. A scheme with more than one credential position (http-basic's
   * username/password) overrides this to decide which side the item fills.
   */
  placeAttachedItem?: (config: Record<string, unknown>, itemRef: string) => Record<string, unknown>;
};

/**
 * A full scheme registration: spec plus the signer. `sign` receives the final
 * outbound request (post-substitution, post-identity-verification) and the
 * resolved real values for the scheme's item-role options, and returns headers
 * to set (and optionally remove) before the request is forwarded.
 */
export type ProxyTransformSchemeDef = ProxyTransformSchemeSpec & {
  sign: ProxyTransformSigner;
};

/** The final outbound request, as seen by a transform signer. */
export type ProxyTransformSignInput = {
  method: string;
  /** Hostname the request is addressed to (the rule host). */
  host: string;
  /** URL path only, no query string. Post-substitution. */
  path: string;
  /** Raw query string without the leading `?`. Post-substitution. */
  query: string;
  /** Final outbound headers (lowercased names; multi-value pre-joined with `,`). */
  headers: Record<string, string>;
  /** The exact body bytes that will be written upstream. */
  body: Buffer;
  /**
   * Resolved REAL values for the scheme's item-role options, keyed by option
   * name (always includes `secretKey`). The runtime guarantees every declared
   * item-role option that is configured has a resolved value here.
   */
  credentials: Record<string, string>;
};

export type ProxyTransformSignResult = | {
  ok: true;
  /** Headers to write onto the outbound request (names lowercased by the runtime). */
  setHeaders: Record<string, string>;
  /** Headers to remove first (e.g. placeholder-signed originals being replaced). */
  removeHeaders?: Array<string>;
} | {
  ok: false;
  error: string;
  /** HTTP status for the fail-closed response. Default 502. */
  status?: number;
};

export type ProxyTransformSigner = (
  transform: ProxyRuleTransform,
  input: ProxyTransformSignInput,
  nowMs: number,
) => ProxyTransformSignResult | Promise<ProxyTransformSignResult>;

/**
 * A request transform on a `@proxy` rule as it appears in rule data: the
 * scheme name, the consumed signing-secret item, and the scheme's own options
 * (shapes declared by the scheme's `ProxyTransformSchemeSpec`; values already
 * validated and normalized at rule build).
 */
export type ProxyRuleTransform = {
  scheme: string;
  /**
   * Item key whose real value the signer consumes, for schemes using the
   * common single-secret shape (hmac, aws-sigv4). Never substituted. Schemes
   * with their own credential positions (http-basic) carry those instead.
   */
  secretKey?: string;
} & Record<string, unknown>;

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
 * The common options every scheme shares. `scheme` is validated separately;
 * the consumed option's required-ness is placement-dependent (defaults to the
 * decorated item on attached rules), so it is enforced at rule build.
 *
 * `secretKey` is the DEFAULT name for a scheme's consumed secret. A scheme may
 * instead declare its own consumed-role option (e.g. http-basic's `password`),
 * which replaces `secretKey` at the schema surface; rule data always
 * canonicalizes to `secretKey`.
 */
export const PROXY_TRANSFORM_COMMON_OPTION_SPECS: Record<string, ProxyTransformOptionSpec> = {
  secretKey: { type: 'string', itemRole: 'consumed' },
};

/** The scheme's consumed-option name at the schema surface (see above). */
export function proxyTransformConsumedOptionName(spec: ProxyTransformSchemeSpec | undefined): string | undefined {
  const own = spec ? Object.entries(spec.options).filter(([, optionSpec]) => optionSpec.itemRole === 'consumed') : [];
  if (own.length === 1) return own[0][0];
  // no own consumed option = the scheme uses the common `secretKey`; more than
  // one = the scheme places credentials itself (see placeAttachedItem)
  return own.length === 0 ? 'secretKey' : undefined;
}

const HMAC_SCHEME_SPEC: ProxyTransformSchemeSpec = {
  options: {
    stringToSign: { required: true, type: 'template' },
    signatureHeader: { required: true, type: 'headerName' },
    keyId: { type: 'string', itemRole: 'wire' },
    keyHeader: { type: 'headerName' },
    timestampHeader: { type: 'headerName' },
    encoding: { type: 'enum', enumValues: PROXY_TRANSFORM_ENCODINGS },
    keyEncoding: { type: 'enum', enumValues: PROXY_TRANSFORM_KEY_ENCODINGS },
    timestampFormat: { type: 'enum', enumValues: PROXY_TRANSFORM_TIMESTAMP_FORMATS },
  },
  validate: (config) => {
    if ((config.keyId === undefined) !== (config.keyHeader === undefined)) {
      return 'transform.keyId and transform.keyHeader must be set together (the key id item and the header it is written to)';
    }
    // A signature over a proxy-generated timestamp the upstream never receives
    // can never verify; require the header that carries it.
    if (typeof config.stringToSign === 'string' && config.stringToSign.includes('{timestamp}') && config.timestampHeader === undefined) {
      return 'transform.stringToSign uses {timestamp} but no timestampHeader is set, so the upstream would have no way to verify the signature. Set timestampHeader to the header the API reads the timestamp from';
    }
    return undefined;
  },
};

/**
 * The HTTP Basic auth transform config. Basic auth defeats placeholder
 * substitution on its own: the child sends `Basic base64(user:placeholder)`,
 * and the encoded placeholder never appears as a substring the proxy could
 * swap. This scheme has the proxy compose the `Authorization: Basic` header
 * itself from the real secret, overwriting whatever the child sent.
 */
export type ProxyRuleHttpBasicTransform = {
  scheme: 'http-basic';
  /**
   * The userid: a literal, or a `$NAME` marker for a consumed credential the
   * proxy resolves at sign time. Omitted = empty userid.
   */
  username?: string;
  /** The password, same forms as `username`. Omitted = empty password. */
  password?: string;
};

const HTTP_BASIC_SCHEME_SPEC: ProxyTransformSchemeSpec = {
  options: {
    // The two credential positions, symmetric: each takes a literal (ordinary
    // config, e.g. a service-account name or a fixed `x-oauth-basic` password)
    // or a `$ITEM` reference, which is a consumed credential the proxy resolves
    // at sign time.
    username: { type: 'string', itemRole: 'consumed', literalAllowed: true },
    password: { type: 'string', itemRole: 'consumed', literalAllowed: true },
  },
  // The decorated item fills whichever side was left unset. With neither given
  // it is the userid: a single-credential Basic API almost always sends the
  // token as the userid with an empty password (`curl -u "token:"`). An empty
  // userid with a secret password is vanishingly rare and is written
  // explicitly as `username=""`.
  placeAttachedItem: (config, itemRef) => {
    if (config.username === undefined) return { ...config, username: itemRef };
    if (config.password === undefined) return { ...config, password: itemRef };
    return config;
  },
  validate: (config) => {
    const isRef = (val: unknown) => typeof val === 'string' && val.startsWith('$');
    if (!isRef(config.username) && !isRef(config.password)) {
      return 'transform needs a credential: reference the item holding the secret with username=$SOME_ITEM or password=$SOME_ITEM. On an attached rule the decorated item fills whichever side you leave unset (the userid when you set neither)';
    }
    // RFC 7617: the userid may not contain a colon (it delimits user:password).
    if (typeof config.username === 'string' && !isRef(config.username) && config.username.includes(':')) {
      return 'transform.username cannot contain ":" (it separates the username from the password in Basic auth)';
    }
    return undefined;
  },
};

/**
 * Scheme SPECS built into core (validation without signers, so schema-side
 * code has no crypto imports). The matching signers live in
 * `request-transform.ts` (`BUILT_IN_TRANSFORM_SCHEMES`); plugins register
 * additional schemes at graph load via `registerProxyTransformScheme`.
 */
export const BUILT_IN_TRANSFORM_SCHEME_SPECS: Record<string, ProxyTransformSchemeSpec> = {
  'hmac-sha256': HMAC_SCHEME_SPEC,
  'hmac-sha512': HMAC_SCHEME_SPEC,
  'http-basic': HTTP_BASIC_SCHEME_SPEC,
};

/** RFC 7230 header-name token. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Header names a transform may never write to: request framing, hop-by-hop,
 * and the same forward/log sinks the substitution surface denylists. A signing
 * config naming one of these would let the proxy itself corrupt framing
 * (`content-length`) or rewrite the verified identity (`host`), so it is a
 * schema error, with no explicit-name override (unlike `substituteIn`, there
 * is no legitimate API that reads a signature from these).
 */
const FORBIDDEN_TRANSFORM_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  ...PROXY_NEVER_AUTO_SUBSTITUTE_HEADERS,
]);
export function isForbiddenTransformHeader(name: string): boolean {
  return FORBIDDEN_TRANSFORM_HEADERS.has(name.toLowerCase()) || isNeverAutoSubstituteHeader(name);
}

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
  schemes: Record<string, ProxyTransformSchemeSpec>,
  opts?: { partial?: boolean },
): string | undefined {
  // Scheme first - it decides which other options are valid and how each is
  // typed. `schemes` is the caller's registry: built-ins only for the static
  // (load-time) pass, built-ins + plugin-registered for resolve time.
  const schemeName = typeof obj.scheme === 'string' ? obj.scheme : undefined;
  const spec = schemeName !== undefined ? schemes[schemeName] : undefined;
  if (schemeName !== undefined && !spec) {
    // In the partial pass an unknown scheme may be a plugin scheme that only
    // resolves once plugins load - defer everything to resolve time.
    if (opts?.partial) return undefined;
    return `unknown transform scheme "${schemeName}". Registered schemes: ${Object.keys(schemes).join(', ')} (plugin-provided schemes need their @plugin(...) declared)`;
  }

  const schemeHasOwnConsumed = spec !== undefined && proxyTransformConsumedOptionName(spec) !== 'secretKey';
  const optionSpecs: Record<string, ProxyTransformOptionSpec> = {
    ...(schemeHasOwnConsumed ? {} : PROXY_TRANSFORM_COMMON_OPTION_SPECS),
    ...spec?.options,
  };
  if (spec) {
    const validKeys = ['scheme', ...Object.keys(optionSpecs)];
    for (const key of Object.keys(obj)) {
      if (!validKeys.includes(key)) {
        return `unknown transform option "${key}" for scheme "${schemeName}". Valid options: ${validKeys.join(', ')}`;
      }
    }
  }

  // Per-option value checks, driven entirely by the option specs.
  for (const [key, optionSpec] of Object.entries(optionSpecs)) {
    const val = obj[key];
    if (val === undefined) continue;
    if (optionSpec.itemRole !== undefined) {
      if (typeof val !== 'string') return `transform.${key} must be a string`;
      const isRef = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(val);
      // A literal is only ordinary config where the scheme allows one; an empty
      // literal is meaningful there (an explicitly empty Basic userid).
      if (!isRef && !optionSpec.literalAllowed) {
        return `transform.${key} must be a reference to a config item, e.g. ${key}=$SOME_ITEM (a literal value here would be a credential embedded in the schema)`;
      }
      continue;
    }
    switch (optionSpec.type) {
      case 'string':
        if (typeof val !== 'string' || !val.trim()) return `transform.${key} must be a non-empty string`;
        break;
      case 'headerName':
        if (typeof val !== 'string' || !HEADER_NAME_RE.test(val)) {
          return `transform.${key} must be a valid header name (letters, digits, and - _ . only)`;
        }
        if (isForbiddenTransformHeader(val)) {
          return `transform.${key} cannot target the "${val.toLowerCase()}" header - it is a framing/identity header the proxy must control`;
        }
        break;
      case 'template':
        if (typeof val !== 'string' || !val.trim()) return `transform.${key} must be a non-empty string`;
        for (const match of val.matchAll(/\{([^{}]*)\}/g)) {
          if (!PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS.includes(match[1] as any)) {
            return `transform.${key} contains unknown field {${match[1]}}. Valid fields: ${PROXY_TRANSFORM_STRING_TO_SIGN_FIELDS.map((f) => `{${f}}`).join(' ')}`;
          }
        }
        break;
      case 'stringList': {
        // Accepts a single string or an array of non-empty strings (like domain/method).
        const entries = Array.isArray(val) ? val : [val];
        if (!entries.length || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
          return `transform.${key} must be one or more non-empty strings, e.g. ${key}=[us-east-1]`;
        }
        break;
      }
      case 'enum':
        if (typeof val !== 'string' || !optionSpec.enumValues?.includes(val)) {
          return `transform.${key} must be one of ${optionSpec.enumValues?.join(', ')}`;
        }
        break;
      default: {
        const exhaustiveCheck: never = optionSpec.type;
        return `transform.${key} has unknown option type ${exhaustiveCheck as string}`;
      }
    }
  }

  if (!opts?.partial) {
    if (schemeName === undefined) return 'transform.scheme is required (e.g. scheme="hmac-sha256")';
    for (const [key, optionSpec] of Object.entries(spec!.options)) {
      if (optionSpec.required && obj[key] === undefined) {
        return `transform.${key} is required for scheme "${schemeName}"`;
      }
    }
    const crossFieldError = spec!.validate?.(obj);
    if (crossFieldError) return crossFieldError;
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
