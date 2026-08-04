/**
 * OAuth provisioning flows for `varlock oauth login`: device code (RFC 8628)
 * and authorization code + PKCE with a loopback redirect (RFC 8252).
 *
 * These are the "flow executor" half of login - they own the PKCE verifier,
 * state, code exchange, and produce the refresh token. The CLI is a thin UI
 * driver over them, which keeps the door open for running the executor inside
 * a remote proxy later while the CLI only displays URLs/codes.
 *
 * Error messages here must never echo token values.
 */

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertValidTokenUrl, requestOauthToken, OauthTokenRequestError,
  OAUTH_DEVICE_CODE_GRANT,
  type OauthClientAuthMethod, type OauthTokenResult,
} from './oauth';

export type OauthLoginConfig = {
  tokenUrl: string;
  authorizationUrl?: string;
  deviceAuthorizationUrl?: string;
  clientId: string;
  clientSecret?: string;
  clientAuth?: OauthClientAuthMethod;
  /** already delimiter-joined per the provider's wire format */
  scope?: string;
  /** extra params for the authorization request (e.g. access_type=offline) */
  extraAuthParams?: Record<string, string>;
};

export type OauthLoginResult = {
  refreshToken: string;
  accessToken?: string;
  expiresInSeconds?: number;
  /** scopes actually granted, when reported */
  grantedScope?: string;
};

export class OauthLoginError extends Error {
  constructor(message: string, readonly tip?: string) {
    super(message);
    this.name = 'OauthLoginError';
  }
}

function base64Url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A login response without a refresh token cannot power oauth() refresh -
 * fail with provider-appropriate guidance rather than storing something useless.
 */
function toLoginResult(result: OauthTokenResult): OauthLoginResult {
  if (!result.refreshToken) {
    throw new OauthLoginError(
      'the provider did not return a refresh token',
      'Some providers need explicit opt-in (e.g. GitHub apps need "user token expiration" enabled; Google needs access_type=offline). Check the app settings and preset notes.',
    );
  }
  return {
    refreshToken: result.refreshToken,
    accessToken: result.accessToken,
    expiresInSeconds: result.expiresInSeconds,
    grantedScope: result.scope,
  };
}

// ── Device code flow (RFC 8628) ────────────────────────────────────────

export type DeviceAuthorizationInfo = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** some providers include a URI with the code embedded */
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
};

export async function requestDeviceAuthorization(config: OauthLoginConfig): Promise<DeviceAuthorizationInfo> {
  if (!config.deviceAuthorizationUrl) {
    throw new OauthLoginError('this provider has no device authorization endpoint configured');
  }
  assertValidTokenUrl(config.deviceAuthorizationUrl, 'deviceAuthorizationUrl');

  const body = new URLSearchParams();
  body.set('client_id', config.clientId);
  if (config.scope) body.set('scope', config.scope);

  let res: Response;
  try {
    res = await fetch(config.deviceAuthorizationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const cause = (err as any)?.cause?.code ?? (err instanceof Error ? err.message : String(err));
    throw new OauthLoginError(`device authorization request failed: ${cause}`);
  }
  const parsed: any = await res.json().catch(() => undefined);
  if (!res.ok || !parsed || typeof parsed !== 'object' || !parsed.device_code) {
    const code = typeof parsed?.error === 'string' ? ` (${parsed.error})` : '';
    throw new OauthLoginError(
      `device authorization request returned HTTP ${res.status}${code}`,
      'Check that the OAuth app supports the device flow (some providers require enabling it)',
    );
  }
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    // google spells it verification_url
    verificationUri: parsed.verification_uri ?? parsed.verification_url,
    verificationUriComplete: parsed.verification_uri_complete,
    expiresInSeconds: Number(parsed.expires_in) || 900,
    pollIntervalSeconds: Number(parsed.interval) || 5,
  };
}

/**
 * Poll the token endpoint until the user approves (or the code expires).
 * `onUserCode` fires once with what to show the user before polling begins.
 */
export async function runDeviceCodeLogin(
  config: OauthLoginConfig,
  hooks: {
    onUserCode: (info: DeviceAuthorizationInfo) => void | Promise<void>;
    signal?: AbortSignal;
  },
): Promise<OauthLoginResult> {
  const deviceAuth = await requestDeviceAuthorization(config);
  await hooks.onUserCode(deviceAuth);

  const deadline = Date.now() + deviceAuth.expiresInSeconds * 1000;
  let intervalMs = deviceAuth.pollIntervalSeconds * 1000;

  while (Date.now() < deadline) {
    if (hooks.signal?.aborted) throw new OauthLoginError('login cancelled');
    await delay(intervalMs);
    try {
      const result = await requestOauthToken({
        tokenUrl: config.tokenUrl,
        grantType: OAUTH_DEVICE_CODE_GRANT,
        deviceCode: deviceAuth.deviceCode,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        clientAuth: config.clientAuth,
      });
      return toLoginResult(result);
    } catch (err) {
      if (err instanceof OauthTokenRequestError) {
        const code = err.details.oauthErrorCode;
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        if (code === 'access_denied') throw new OauthLoginError('login was denied by the user');
        if (code === 'expired_token') break;
      }
      throw err;
    }
  }
  throw new OauthLoginError('the device code expired before login was completed - try again');
}

// ── Authorization code + PKCE with loopback redirect (RFC 8252) ────────

const PKCE_CALLBACK_PATH = '/oauth/callback';
const DEFAULT_PKCE_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_RESPONSE_HTML = (message: string) => `<!doctype html>
<meta charset="utf-8"><title>varlock</title>
<body style="font-family: system-ui; padding: 4em; text-align: center;">
<h2>${message}</h2><p>You can close this tab and return to your terminal.</p></body>`;

/**
 * Runs a loopback server, hands the authorization URL to `onAuthorizationUrl`
 * (the caller opens it in a browser), waits for the provider to redirect back
 * with a code, and exchanges it.
 */
export async function runPkceLogin(
  config: OauthLoginConfig,
  hooks: {
    onAuthorizationUrl: (url: string) => void | Promise<void>;
    timeoutMs?: number;
  },
): Promise<OauthLoginResult> {
  if (!config.authorizationUrl) {
    throw new OauthLoginError('this provider has no authorization endpoint configured');
  }
  assertValidTokenUrl(config.authorizationUrl, 'authorizationUrl');

  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const state = base64Url(randomBytes(16));

  let resolveCallback: (result: { code: string } | { error: string }) => void;
  const callbackReceived = new Promise<{ code: string } | { error: string }>((resolve) => {
    resolveCallback = resolve;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== PKCE_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const errorParam = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');
    if (errorParam) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(CALLBACK_RESPONSE_HTML('Login failed'));
      resolveCallback({ error: `provider returned error "${errorParam}"` });
    } else if (!code || returnedState !== state) {
      // a state mismatch means this redirect was not initiated by us - reject it
      res.writeHead(400, { 'content-type': 'text/html' }).end(CALLBACK_RESPONSE_HTML('Login failed'));
      resolveCallback({ error: 'callback state mismatch - possible interception or a stale login attempt' });
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end(CALLBACK_RESPONSE_HTML('Login successful'));
      resolveCallback({ code });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${PKCE_CALLBACK_PATH}`;

  try {
    const authUrl = new URL(config.authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (config.scope) authUrl.searchParams.set('scope', config.scope);
    for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
      authUrl.searchParams.set(key, value);
    }
    await hooks.onAuthorizationUrl(authUrl.toString());

    const outcome = await Promise.race([
      callbackReceived,
      delay(hooks.timeoutMs ?? DEFAULT_PKCE_TIMEOUT_MS).then(() => ({ error: 'timed out waiting for the browser login to complete' })),
    ]);
    if ('error' in outcome) throw new OauthLoginError(outcome.error);

    const result = await requestOauthToken({
      tokenUrl: config.tokenUrl,
      grantType: 'authorization_code',
      code: outcome.code,
      redirectUri,
      codeVerifier,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      clientAuth: config.clientAuth,
    });
    return toLoginResult(result);
  } finally {
    server.close();
  }
}
