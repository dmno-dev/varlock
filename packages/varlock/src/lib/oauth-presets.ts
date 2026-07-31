/**
 * Data-driven presets for well-known OAuth providers, used by the
 * `@oauthProvider` root decorator. A preset fills in endpoints and quirks so
 * users only supply their own client credentials.
 *
 * Keep these entries pure data - anything requiring provider-specific code
 * belongs in a plugin instead.
 */

import type { OauthClientAuthMethod } from './oauth';

export type OauthProviderPreset = {
  /** display label */
  label: string;
  tokenUrl: string;
  /** authorization endpoint for the browser (PKCE) login flow */
  authorizationUrl?: string;
  /** device authorization endpoint (RFC 8628) - presence means device flow is supported */
  deviceAuthorizationUrl?: string;
  /** how client credentials are sent to the token endpoint */
  clientAuth?: OauthClientAuthMethod;
  /** extra params required on the authorization request (e.g. to get a refresh token at all) */
  extraAuthParams?: Record<string, string>;
  /** scopes that must always be requested during login (e.g. offline_access) */
  requiredLoginScopes?: Array<string>;
  /** delimiter for joining multiple scopes on the wire (default: space) */
  scopesDelimiter?: string;
  /** where to register an OAuth app for this provider */
  appSetupUrl?: string;
  /** shown in login guidance and error tips */
  notes?: string;
};

export const OAUTH_PROVIDER_PRESETS: Record<string, OauthProviderPreset> = {
  google: {
    label: 'Google',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    deviceAuthorizationUrl: 'https://oauth2.googleapis.com/device/code',
    // without these the authorization flow never returns a refresh token
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    appSetupUrl: 'https://console.cloud.google.com/apis/credentials',
    notes: 'Register a "Desktop app" OAuth client (loopback redirects are allowed implicitly). Device flow supports a limited set of scopes; clientSecret is required for token exchange even for desktop clients (it is not treated as confidential).',
  },
  github: {
    label: 'GitHub',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    deviceAuthorizationUrl: 'https://github.com/login/device/code',
    appSetupUrl: 'https://github.com/settings/developers',
    notes: 'Enable device flow on the OAuth app for device login. Refresh tokens are only issued when "user token expiration" is enabled on the app; otherwise tokens are long-lived and oauth() refresh does not apply.',
  },
  microsoft: {
    label: 'Microsoft (Entra ID)',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    deviceAuthorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    requiredLoginScopes: ['offline_access'],
    appSetupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    notes: 'Register a public client (mobile & desktop) app. The default endpoints use the "common" tenant; set tokenUrl/authorizationUrl explicitly to pin a tenant.',
  },
  slack: {
    label: 'Slack',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    scopesDelimiter: ',',
    appSetupUrl: 'https://api.slack.com/apps',
    notes: 'Slack has no device flow and requires https redirect URLs, so the local browser login flow does not work; provision a refresh token elsewhere and pass it via refreshToken. Refresh tokens require token rotation to be enabled on the app.',
  },
};

export const OAUTH_PRESET_NAMES = Object.keys(OAUTH_PROVIDER_PRESETS);
