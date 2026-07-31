/**
 * OAuth 2.0 token endpoint client (RFC 6749).
 *
 * Powers the `oauth()` resolver function: exchanges a long-lived credential
 * (refresh token, or client id + secret) for a short-lived access token by
 * POSTing to a provider's token endpoint.
 *
 * Error messages here must never echo token or secret values, since resolver
 * errors are printed unredacted.
 */

import { createHash } from 'node:crypto';

/** grant types usable from the oauth() resolver */
export const OAUTH_GRANT_TYPES = ['refresh_token', 'client_credentials'] as const;
export type OauthGrantType = typeof OAUTH_GRANT_TYPES[number];

export const OAUTH_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** all grants the token client can send - provisioning grants included */
export type OauthTokenRequestGrantType = OauthGrantType | 'authorization_code' | typeof OAUTH_DEVICE_CODE_GRANT;

export const OAUTH_CLIENT_AUTH_METHODS = ['body', 'basic'] as const;
/** How client credentials are sent: form body params (client_secret_post) or HTTP basic auth (client_secret_basic) */
export type OauthClientAuthMethod = typeof OAUTH_CLIENT_AUTH_METHODS[number];

const DEFAULT_TIMEOUT_MS = 30_000;
/** Max chars of provider error description we echo back in error messages */
const MAX_ERROR_DESCRIPTION_LENGTH = 300;

/** Params callers may not pass via extraParams because we set them ourselves */
export const OAUTH_RESERVED_PARAMS = ['grant_type', 'refresh_token', 'client_id', 'client_secret', 'scope'];

export class OauthTokenRequestError extends Error {
  constructor(
    message: string,
    readonly details: {
      /** HTTP status of the token endpoint response, if one was received */
      status?: number;
      /** standard OAuth error code from the response body (e.g. `invalid_grant`) */
      oauthErrorCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'OauthTokenRequestError';
  }
}

/**
 * Validates an OAuth endpoint URL. Must be https, except localhost is allowed
 * over plain http (tests, local identity providers).
 */
export function assertValidTokenUrl(tokenUrl: string, label = 'tokenUrl'): URL {
  let parsed: URL;
  try {
    parsed = new URL(tokenUrl);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return parsed;
    throw new Error(`${label} must use https (plain http is only allowed for localhost)`);
  }
  throw new Error(`${label} must be an http(s) URL`);
}

export type OauthTokenRequestOpts = {
  tokenUrl: string;
  grantType: OauthTokenRequestGrantType;
  clientId?: string;
  clientSecret?: string;
  /** how to send client credentials - form body (default) or HTTP basic auth */
  clientAuth?: OauthClientAuthMethod;
  /** required for the refresh_token grant */
  refreshToken?: string;
  /** required for the authorization_code grant */
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  /** required for the device_code grant */
  deviceCode?: string;
  /** already delimiter-joined per the OAuth wire format */
  scope?: string;
  /** additional form body params (e.g. audience, resource) */
  extraParams?: Record<string, string>;
  timeoutMs?: number;
};

export type OauthTokenResult = {
  accessToken: string;
  /** lifetime reported by the provider; undefined when the response omits expires_in */
  expiresInSeconds?: number;
  /** present when the provider rotates refresh tokens */
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
};

// ── cache keys + entry shapes ──────────────────────────────────────────
// Shared between the oauth() resolver and the `varlock oauth login` CLI so
// both compute identical keys.

/** access-token cache entry, one per (item scope-set) */
export type OauthItemCacheEntry = {
  accessToken: string;
  /** epoch ms when the access token stops being usable (provider-reported) */
  expiresAt: number;
  /** latest rotated refresh token - only used when the refresh token is item-configured */
  refreshToken?: string;
  scope?: string;
  lastRefreshedAt: number;
  refreshCount: number;
};

/** provider-level entry - the live home of a login-provisioned refresh token, shared across items */
export type OauthProviderCacheEntry = {
  refreshToken: string;
  /** scopes granted at login (may be broader than any one item's request) */
  grantedScope?: string;
  updatedAt: number;
  source: 'login' | 'rotation';
};

/** key for an item's access-token entry, scoped to the exact credentials + scopes */
export function buildOauthItemCacheKey(parts: {
  tokenUrl: string;
  grantType: string;
  clientId: string;
  scope?: string;
  /** the CONFIGURED bootstrap refresh token (not a rotated one); empty for login-provisioned */
  refreshToken?: string;
}): string {
  const keyMaterial = [parts.tokenUrl, parts.grantType, parts.clientId, parts.scope ?? '', parts.refreshToken ?? ''].join('\n');
  const digest = createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16);
  return `oauth:${new URL(parts.tokenUrl).hostname}:${digest}`;
}

/** key for the shared provider-level refresh-token entry, written by `varlock oauth login` */
export function buildOauthProviderCacheKey(parts: { tokenUrl: string; clientId: string }): string {
  const keyMaterial = [parts.tokenUrl, parts.clientId].join('\n');
  const digest = createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16);
  return `oauth:${new URL(parts.tokenUrl).hostname}:provider-${digest}`;
}

/** display helper - scopes string or a placeholder when none requested */
export function formatOauthScopesForDisplay(scope: string | undefined): string {
  return scope || '(provider default)';
}

function truncate(str: string, maxLen: number) {
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

/** Extracts a standard OAuth error shape from a response body, tolerating non-JSON */
function parseErrorBody(bodyText: string): { code?: string; description?: string } {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') {
      return {
        code: typeof parsed.error === 'string' ? parsed.error : undefined,
        description: typeof parsed.error_description === 'string' ? parsed.error_description : undefined,
      };
    }
  } catch { /* not json */ }
  return {};
}

/**
 * POST to an OAuth token endpoint and parse the response.
 * Throws OauthTokenRequestError on any failure; messages never contain secret values.
 */
export async function requestOauthToken(opts: OauthTokenRequestOpts): Promise<OauthTokenResult> {
  const url = assertValidTokenUrl(opts.tokenUrl);

  const body = new URLSearchParams();
  body.set('grant_type', opts.grantType);
  if (opts.grantType === 'refresh_token') {
    if (!opts.refreshToken) throw new OauthTokenRequestError('refresh_token grant requires a refresh token');
    body.set('refresh_token', opts.refreshToken);
  } else if (opts.grantType === 'authorization_code') {
    if (!opts.code || !opts.redirectUri) {
      throw new OauthTokenRequestError('authorization_code grant requires code and redirectUri');
    }
    body.set('code', opts.code);
    body.set('redirect_uri', opts.redirectUri);
    if (opts.codeVerifier) body.set('code_verifier', opts.codeVerifier);
  } else if (opts.grantType === OAUTH_DEVICE_CODE_GRANT) {
    if (!opts.deviceCode) throw new OauthTokenRequestError('device_code grant requires deviceCode');
    body.set('device_code', opts.deviceCode);
  }
  if (opts.scope) body.set('scope', opts.scope);
  for (const [key, value] of Object.entries(opts.extraParams ?? {})) {
    if (OAUTH_RESERVED_PARAMS.includes(key)) {
      throw new OauthTokenRequestError(`params may not override reserved param "${key}"`);
    }
    body.set(key, value);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (opts.clientAuth === 'basic') {
    if (!opts.clientId) throw new OauthTokenRequestError('clientAuth=basic requires clientId');
    // RFC 6749 §2.3.1 - credentials are form-urlencoded before base64
    const encoded = Buffer.from(
      `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret ?? '')}`,
    ).toString('base64');
    headers.authorization = `Basic ${encoded}`;
  } else {
    if (opts.clientId) body.set('client_id', opts.clientId);
    if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new OauthTokenRequestError(`token endpoint request timed out (${url.host})`);
    }
    const cause = (err as any)?.cause?.code ?? (err instanceof Error ? err.message : String(err));
    throw new OauthTokenRequestError(`token endpoint request failed (${url.host}): ${cause}`);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    const { code, description } = parseErrorBody(bodyText);
    let message = `token endpoint returned HTTP ${res.status}`;
    if (code) message += ` (${code})`;
    if (description) message += `: ${truncate(description, MAX_ERROR_DESCRIPTION_LENGTH)}`;
    throw new OauthTokenRequestError(message, { status: res.status, oauthErrorCode: code });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new OauthTokenRequestError('token endpoint returned a non-JSON response');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new OauthTokenRequestError('token endpoint returned an unexpected response shape');
  }

  // some providers (e.g. Slack) return errors with HTTP 200
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    const code = typeof parsed.error === 'string' ? parsed.error : undefined;
    let message = 'token endpoint response is missing access_token';
    if (code) {
      message = `token endpoint returned an error (${code})`;
      if (typeof parsed.error_description === 'string') {
        message += `: ${truncate(parsed.error_description, MAX_ERROR_DESCRIPTION_LENGTH)}`;
      }
    }
    throw new OauthTokenRequestError(message, { status: res.status, oauthErrorCode: code });
  }

  // expires_in should be a number of seconds, but some providers send a string
  let expiresInSeconds: number | undefined;
  if (parsed.expires_in !== undefined) {
    const num = Number(parsed.expires_in);
    if (Number.isFinite(num) && num > 0) expiresInSeconds = num;
  }

  return {
    accessToken: parsed.access_token,
    expiresInSeconds,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}
