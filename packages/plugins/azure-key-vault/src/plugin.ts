import {
  type Resolver, type PluginCacheAccessor, plugin, resolveCacheTtl,
} from 'varlock/plugin-lib';
import ky from 'ky';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getOidcToken } from '@env-spec/utils/oidc-tokens';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const AZURE_ICON = 'skill-icons:azure-dark';

/** Entra token resources (the `/.default` scope is derived from these) */
const KEY_VAULT_RESOURCE = 'https://vault.azure.net';
const APP_CONFIG_RESOURCE = 'https://azconfig.io';

const KEY_VAULT_API_VERSION = '7.4';
const APP_CONFIG_API_VERSION = '2023-11-01';
const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';

/** content type of an App Configuration setting that references a Key Vault secret */
const KEY_VAULT_REF_CONTENT_TYPE = 'application/vnd.microsoft.appconfig.keyvaultref+json';
/** App Configuration's filter value for settings that have no label */
const NO_LABEL_FILTER = '\0';

plugin.name = 'azure';
const { debug } = plugin;
debug('init - version =', plugin.version);
// capture cache accessor while plugin proxy context is active
let pluginCache: PluginCacheAccessor | undefined;
try {
  pluginCache = plugin.cache;
} catch {
  // cache unavailable in this runtime context
}
plugin.icon = AZURE_ICON;
plugin.standardVars = {
  initDecorator: '@initAzure',
  params: {
    tenantId: { key: 'AZURE_TENANT_ID' },
    clientId: { key: 'AZURE_CLIENT_ID' },
    clientSecret: { key: 'AZURE_CLIENT_SECRET' },
    appConfigEndpoint: { key: 'AZURE_APPCONFIG_ENDPOINT' },
    appConfigConnectionString: {
      key: 'AZURE_APPCONFIG_CONNECTION_STRING',
      dataType: 'azureAppConfigConnectionString',
    },
  },
};

interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface AppConfigConnection {
  endpoint: string;
  id: string;
  secret: Buffer;
}

interface AppConfigSetting {
  key: string;
  label?: string | null;
  value?: string | null;
  content_type?: string | null;
}

interface AppConfigListPage {
  items?: Array<AppConfigSetting>;
  '@nextLink'?: string;
}

interface AzureInstanceConfig {
  vaultUrl?: unknown;
  appConfigEndpoint?: unknown;
  appConfigConnectionString?: unknown;
  defaultLabel?: unknown;
  authorityHost?: unknown;
  tenantId?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  oidcToken?: unknown;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

/** strip trailing slashes so paths can be appended safely */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function parseAppConfigConnectionString(raw: string): AppConfigConnection {
  const parts: Record<string, string> = {};
  for (const segment of raw.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) continue;
    parts[segment.slice(0, eqIndex).trim().toLowerCase()] = segment.slice(eqIndex + 1).trim();
  }
  const { endpoint, id, secret } = parts;
  if (!endpoint || !id || !secret) {
    throw new SchemaError('Invalid Azure App Configuration connection string', {
      tip: 'Expected format: Endpoint=https://<store>.azconfig.io;Id=<id>;Secret=<secret>',
    });
  }
  return { endpoint: normalizeEndpoint(endpoint), id, secret: Buffer.from(secret, 'base64') };
}

/**
 * Build the headers for App Configuration access-key (HMAC-SHA256) authentication.
 * See https://learn.microsoft.com/en-us/azure/azure-app-configuration/rest-api-authentication-hmac
 */
function signAppConfigRequest(conn: AppConfigConnection, method: string, url: URL): Record<string, string> {
  const date = new Date().toUTCString();
  // GET requests have an empty body
  const contentHash = createHash('sha256').update('').digest('base64');
  const stringToSign = `${method.toUpperCase()}\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`;
  const signature = createHmac('sha256', conn.secret).update(stringToSign, 'utf8').digest('base64');
  return {
    'x-ms-date': date,
    'x-ms-content-sha256': contentHash,
    Authorization: `HMAC-SHA256 Credential=${conn.id}&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  };
}

function hasContentType(setting: AppConfigSetting, contentType: string): boolean {
  const actual = setting.content_type;
  if (!actual) return false;
  return actual.split(';')[0].trim().toLowerCase() === contentType;
}

/** parse a Key Vault secret identifier, e.g. https://my-vault.vault.azure.net/secrets/my-secret/abc123 */
function parseKeyVaultSecretUri(uri: string): { vaultUrl: string; secretName: string; version?: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ResolutionError(`Invalid Key Vault reference URI: ${uri}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'secrets' || !segments[1]) {
    throw new ResolutionError(`Key Vault reference does not point to a secret: ${uri}`, {
      tip: 'Expected a URI like https://<vault>.vault.azure.net/secrets/<name>[/<version>]',
    });
  }
  return { vaultUrl: parsed.origin, secretName: segments[1], version: segments[2] };
}

class AzurePluginInstance {
  private vaultUrl?: string;
  private appConfigEndpoint?: string;
  private appConfigConnection?: AppConfigConnection;
  private defaultLabel?: string;
  private authorityHost = DEFAULT_AUTHORITY_HOST;
  private tenantId?: string;
  private clientId?: string;
  private clientSecret?: string;
  private oidcToken?: string;
  /** cached Entra access tokens, keyed by resource (Key Vault and App Configuration use different scopes) */
  private cachedTokens = new Map<string, CachedToken>();
  private fetchCache = new Map<string, Promise<string>>();
  /** optional cache TTL - when set, resolved values are cached */
  cacheTtl?: string | number;

  constructor(
    readonly id: string,
  ) {
  }

  setConfig(config: AzureInstanceConfig) {
    this.vaultUrl = asOptionalString(config.vaultUrl);
    this.vaultUrl &&= normalizeEndpoint(this.vaultUrl);
    this.appConfigEndpoint = asOptionalString(config.appConfigEndpoint);
    this.appConfigEndpoint &&= normalizeEndpoint(this.appConfigEndpoint);
    const connectionString = asOptionalString(config.appConfigConnectionString);
    if (connectionString && this.appConfigEndpoint) {
      throw new SchemaError('Provide either appConfigEndpoint or appConfigConnectionString, not both', {
        tip: 'The connection string already contains the store endpoint',
      });
    }
    this.appConfigConnection = connectionString ? parseAppConfigConnectionString(connectionString) : undefined;
    this.defaultLabel = asOptionalString(config.defaultLabel);
    const authorityHost = asOptionalString(config.authorityHost);
    this.authorityHost = authorityHost ? normalizeEndpoint(authorityHost) : DEFAULT_AUTHORITY_HOST;
    this.tenantId = asOptionalString(config.tenantId);
    this.clientId = asOptionalString(config.clientId);
    this.clientSecret = asOptionalString(config.clientSecret);
    this.oidcToken = asOptionalString(config.oidcToken);
    debug(
      'azure instance',
      this.id,
      'set config - vaultUrl:',
      this.vaultUrl,
      'appConfigEndpoint:',
      this.appConfigStoreEndpoint,
      'hasAppConfigConnectionString:',
      !!this.appConfigConnection,
      'hasDefaultLabel:',
      !!this.defaultLabel,
      'hasTenantId:',
      !!this.tenantId,
      'hasClientId:',
      !!this.clientId,
      'hasClientSecret:',
      !!this.clientSecret,
      'hasOidcToken:',
      !!this.oidcToken,
    );
  }

  get hasKeyVault() {
    return !!this.vaultUrl;
  }

  get hasAppConfig() {
    return !!this.appConfigStoreEndpoint;
  }

  get appConfigDefaultLabel() {
    return this.defaultLabel;
  }

  get hasAppConfigConnectionString() {
    return !!this.appConfigConnection;
  }

  /** the App Configuration store endpoint, from either the explicit endpoint or the connection string */
  private get appConfigStoreEndpoint(): string | undefined {
    return this.appConfigConnection?.endpoint ?? this.appConfigEndpoint;
  }

  /**
   * @internal telemetry: which auth method this instance is *configured* for (fixed enum, no user input).
   * 'ambient' means no explicit credentials were configured, so auth falls back to the runtime
   * chain (Managed Identity / Azure CLI) determined at resolve time.
   * 'connection_string' means only an App Configuration access key was configured.
   */
  get telemetryAuthMethod(): 'service_principal' | 'oidc_federated' | 'connection_string' | 'ambient' {
    if (this.tenantId && this.clientId && this.clientSecret) return 'service_principal';
    if (this.tenantId && this.clientId) return 'oidc_federated';
    if (this.appConfigConnection) return 'connection_string';
    return 'ambient';
  }

  private _cacheKeyIdentity?: string;
  /** short hash identifying which Key Vault is being read, used to namespace cache keys */
  get cacheKeyIdentity() {
    // the vault URL globally identifies the vault; included as a hash for consistency with other plugins
    this._cacheKeyIdentity ??= createHash('sha256')
      .update(JSON.stringify([this.vaultUrl]))
      .digest('hex')
      .slice(0, 12);
    return this._cacheKeyIdentity;
  }

  private _appConfigCacheKeyIdentity?: string;
  /**
   * short hash identifying which App Configuration store is being read, used to namespace cache keys.
   * Only the endpoint is hashed, never the connection string (cache keys are stored in plaintext).
   */
  get appConfigCacheKeyIdentity() {
    this._appConfigCacheKeyIdentity ??= createHash('sha256')
      .update(JSON.stringify([this.appConfigStoreEndpoint]))
      .digest('hex')
      .slice(0, 12);
    return this._appConfigCacheKeyIdentity;
  }

  private cacheToken(resource: string, token: string, expiresAt: number) {
    this.cachedTokens.set(resource, { token, expiresAt });
  }

  private async getAzureCliToken(resource: string): Promise<string | undefined> {
    const scope = `${resource}/.default`;

    // Try the older accessTokens.json format first
    try {
      const tokenCachePath = join(homedir(), '.azure', 'accessTokens.json');
      const tokenCacheContent = await readFile(tokenCachePath, 'utf-8');
      const tokens = JSON.parse(tokenCacheContent);

      // Find a valid token for the requested resource
      const now = new Date();
      const validToken = tokens.find((t: any) => {
        const expiresOn = new Date(t.expiresOn);
        // `_authority` looks like https://login.microsoftonline.com/<tenant>; only accept a
        // cached token whose issuing tenant matches the configured one (see MSAL note below).
        const tenantMatches = !this.tenantId
          || (typeof t._authority === 'string' && t._authority.includes(this.tenantId));
        return t.resource === resource
          && expiresOn > now
          && t.tokenType === 'Bearer'
          && tenantMatches;
      });

      if (validToken) {
        debug(`Found valid Azure CLI token for ${resource} in accessTokens.json`);
        this.cacheToken(resource, validToken.accessToken, new Date(validToken.expiresOn).getTime());
        return validToken.accessToken;
      }
    } catch (err) {
      debug('Could not read accessTokens.json:', err);
    }

    // Try the newer MSAL token cache format
    try {
      const msalCachePath = join(homedir(), '.azure', 'msal_token_cache.json');
      const msalCacheContent = await readFile(msalCachePath, 'utf-8');
      const msalCache = JSON.parse(msalCacheContent);

      // MSAL format has AccessToken entries
      const accessTokens = msalCache.AccessToken || {};
      const now = Math.floor(Date.now() / 1000);

      // Find a valid token for the requested resource.
      // When a tenantId is configured we must match it against the token's `realm`
      // (the tenant that issued the token). With multiple `az login` accounts the cache
      // can hold valid tokens for several tenants; handing a token from the wrong tenant
      // to the service yields a confusing 401 ("token expired or invalid").
      for (const [_key, token] of Object.entries(accessTokens) as Array<[string, any]>) {
        if (token.target?.includes(scope)
          && token.expires_on > now
          && token.secret) {
          if (this.tenantId && token.realm !== this.tenantId) {
            debug(`Skipping cached MSAL token for tenant ${token.realm} (need ${this.tenantId})`);
            continue;
          }
          debug(`Found valid Azure CLI token for ${resource} from MSAL cache`);
          this.cacheToken(resource, token.secret, token.expires_on * 1000);
          return token.secret;
        }
      }
    } catch (err) {
      debug('Could not read MSAL token cache:', err);
    }

    // If no cached token found, try to get one directly from az CLI
    try {
      debug('No cached token found, attempting to get token from az CLI directly');
      // Scope the request to the configured tenant so we don't get a token for the wrong account.
      const tenantArg = this.tenantId ? ` --tenant ${this.tenantId}` : '';
      const result = execSync(`az account get-access-token --resource ${resource}${tenantArg}`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'], // Suppress stderr
      });

      const tokenData = JSON.parse(result);
      if (tokenData.accessToken && tokenData.expiresOn) {
        debug('Successfully obtained token from az CLI');

        // Parse expiresOn - can be in different formats
        let expiresAt: number;
        if (typeof tokenData.expiresOn === 'number') {
          expiresAt = tokenData.expiresOn * 1000;
        } else {
          expiresAt = new Date(tokenData.expiresOn).getTime();
        }

        this.cacheToken(resource, tokenData.accessToken, expiresAt);
        return tokenData.accessToken;
      }
    } catch (err) {
      debug('Could not get token from az CLI:', err);
    }

    debug('No valid Azure CLI token found');
    return undefined;
  }

  private async getManagedIdentityToken(resource: string): Promise<string | undefined> {
    try {
      debug('Attempting to get token from Managed Identity (IMDS)');

      // Azure Instance Metadata Service endpoint
      const imdsEndpoint = 'http://169.254.169.254/metadata/identity/oauth2/token';

      const response = await ky.get(imdsEndpoint, {
        searchParams: {
          'api-version': '2018-02-01',
          resource,
        },
        headers: {
          Metadata: 'true',
        },
        timeout: 3000, // Quick timeout - if we're not on Azure, this will fail fast
      }).json<AzureTokenResponse>();

      if (response.access_token && response.expires_in) {
        debug('Successfully obtained token from Managed Identity');
        this.cacheToken(resource, response.access_token, Date.now() + (response.expires_in * 1000));
        return response.access_token;
      }
    } catch (err) {
      debug('Managed Identity not available (not running on Azure or identity not assigned)');
    }

    return undefined;
  }

  private get tokenUrl() {
    return `${this.authorityHost}/${this.tenantId}/oauth2/v2.0/token`;
  }

  private async getFederatedCredentialToken(resource: string, clientId: string): Promise<string | undefined> {
    // Get OIDC token - either explicit or auto-detected from platform
    let jwt: string | undefined = this.oidcToken;
    if (!jwt) {
      const result = await getOidcToken('api://AzureADTokenExchange');
      jwt = result?.token;
    }

    if (!jwt) {
      debug('No OIDC token available for federated credential');
      return undefined;
    }

    try {
      debug('Exchanging OIDC token for Azure access token via federated credential');

      const response = await ky.post(this.tokenUrl, {
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: jwt,
          scope: `${resource}/.default`,
        }),
      }).json<AzureTokenResponse>();

      this.cacheToken(resource, response.access_token, Date.now() + (response.expires_in * 1000));

      debug('Successfully obtained Azure access token via federated credential');
      return response.access_token;
    } catch (err: any) {
      debug('Federated credential exchange failed:', err.message || err);
      return undefined;
    }
  }

  /**
   * Get an Entra access token for the given resource (e.g. Key Vault or App Configuration).
   * Tokens are cached per resource since each service requires its own scope.
   */
  private async getAccessToken(resource: string): Promise<string> {
    // Check if we have a cached token that's still valid (with 5 min buffer)
    const cachedToken = this.cachedTokens.get(resource);
    if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
      debug(`Using cached Azure access token for ${resource}`);
      return cachedToken.token;
    }

    // First priority: Use explicitly provided service principal credentials
    const tenantId = this.tenantId;
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;

    // If all credentials are explicitly provided, use them
    if (tenantId && clientId && clientSecret) {
      debug('Using explicitly provided service principal credentials');
      return this.getServicePrincipalToken(resource, clientId, clientSecret);
    }

    // Second priority: OIDC federated credential (tenantId + clientId without clientSecret)
    if (tenantId && clientId) {
      const federatedToken = await this.getFederatedCredentialToken(resource, clientId);
      if (federatedToken) {
        debug('Using OIDC federated credential authentication');
        return federatedToken;
      }
    }

    // Third priority: Try Managed Identity (for Azure-hosted apps)
    const managedIdentityToken = await this.getManagedIdentityToken(resource);
    if (managedIdentityToken) {
      debug('Using Managed Identity authentication');
      return managedIdentityToken;
    }

    // Fourth priority: Fall back to Azure CLI authentication
    const cliToken = await this.getAzureCliToken(resource);
    if (cliToken) {
      debug('Using Azure CLI authentication');
      return cliToken;
    }

    const roleName = resource === APP_CONFIG_RESOURCE ? 'App Configuration Data Reader' : 'Key Vault Secrets User';
    const resourceLabel = resource === APP_CONFIG_RESOURCE ? 'App Configuration store' : 'Key Vault';

    // No credentials available
    throw new SchemaError('Azure credentials are required', {
      tip: [
        'Option 1: Use Azure CLI (easiest for local development)',
        '  - Run: az login',
        '  - This will automatically work with varlock',
        '',
        'Option 2: Use OIDC federated credential (for Vercel, GitHub Actions, etc.)',
        '  - Provide tenantId and clientId via @initAzure(tenantId=..., clientId=...)',
        '  - Configure a federated credential on your Azure App Registration',
        '  - No client secret needed!',
        '',
        'Option 3: Use Managed Identity (for Azure-hosted apps)',
        '  - Enable system-assigned or user-assigned managed identity on your Azure resource',
        `  - Grant the identity the "${roleName}" role on your ${resourceLabel}`,
        '  - No credentials needed in your code!',
        '',
        'Option 4: Provide service principal credentials via @initAzure():',
        '  - tenantId: Your Azure AD tenant ID',
        '  - clientId: Your service principal application (client) ID',
        '  - clientSecret: Your service principal client secret',
        ...(resource === APP_CONFIG_RESOURCE ? [
          '',
          'Option 5: Use an App Configuration access key via @initAzure(appConfigConnectionString=...)',
        ] : []),
      ].join('\n'),
    });
  }

  private async getServicePrincipalToken(resource: string, clientId: string, clientSecret: string): Promise<string> {
    try {
      debug('Fetching new Azure access token with service principal');

      const response = await ky.post(this.tokenUrl, {
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: `${resource}/.default`,
        }),
      }).json<AzureTokenResponse>();

      // Cache the token (expires_in is in seconds)
      this.cacheToken(resource, response.access_token, Date.now() + (response.expires_in * 1000));

      debug('Successfully obtained Azure access token');
      return response.access_token;
    } catch (err: any) {
      let errorMessage = 'Failed to authenticate with Azure';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          errorMessage = 'Authentication failed - invalid credentials';
          errorTip = [
            'Verify your Azure credentials are correct:',
            '  - Tenant ID should be a valid Azure AD tenant GUID',
            '  - Client ID should be a valid service principal application ID',
            '  - Client Secret should be a valid, non-expired secret',
            '',
            'Learn more: https://learn.microsoft.com/en-us/azure/active-directory/develop/howto-create-service-principal-portal',
          ].join('\n');
        } else {
          try {
            const errorBody = await err.response.json();
            errorMessage = `Azure authentication error: ${errorBody.error_description || errorBody.error || err.message}`;
          } catch {
            errorMessage = `Azure authentication error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error during Azure authentication: ${err.message}`;
      }

      throw new SchemaError(errorMessage, { tip: errorTip });
    }
  }

  /** deduplicate concurrent fetches for the same resource */
  private dedupeFetch(cacheKey: string, fetcher: () => Promise<string>): Promise<string> {
    const cached = this.fetchCache.get(cacheKey);
    if (cached) {
      debug(`Using in-flight fetch for: ${cacheKey}`);
      return cached;
    }
    const promise = fetcher();
    this.fetchCache.set(cacheKey, promise);
    // Clear cache entry on failure so retries can try again
    promise.catch(() => this.fetchCache.delete(cacheKey));
    return promise;
  }

  // Key Vault ----------------------------------------------------------------

  fetchSecretValue(secretRef: string): Promise<string> {
    if (!this.vaultUrl) {
      throw new SchemaError(`Azure plugin instance "${this.id}" has no vaultUrl configured`, {
        tip: 'azureSecret() requires a Key Vault. Add vaultUrl="https://<vault>.vault.azure.net/" to your @initAzure() call',
      });
    }
    // Parse secret reference: "secretName" or "secretName@version"
    const [secretName, version] = secretRef.split('@');
    return this.fetchSecretFromVault(this.vaultUrl, secretName, version);
  }

  /** fetch a secret from any Key Vault (the configured one, or one named by an App Configuration reference) */
  fetchSecretFromVault(vaultUrl: string, secretName: string, version?: string): Promise<string> {
    const secretUrl = version
      ? `${vaultUrl}/secrets/${secretName}/${version}`
      : `${vaultUrl}/secrets/${secretName}`;
    return this.dedupeFetch(secretUrl, () => this._fetchSecretFromVault(vaultUrl, secretUrl, secretName, version));
  }

  private async _fetchSecretFromVault(
    vaultUrl: string,
    secretUrl: string,
    secretName: string,
    version?: string,
  ): Promise<string> {
    try {
      const accessToken = await this.getAccessToken(KEY_VAULT_RESOURCE);

      debug(`Fetching secret: ${secretName}${version ? `@${version}` : ''} from ${vaultUrl}`);

      const response = await ky.get(`${secretUrl}?api-version=${KEY_VAULT_API_VERSION}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }).json<{ value: string }>();

      if (!response.value) {
        throw new ResolutionError('Secret value is empty');
      }

      debug(`Successfully fetched secret: ${secretName}`);
      return response.value;
    } catch (err: any) {
      // Re-throw our own errors as-is
      if (err instanceof ResolutionError || err instanceof SchemaError) {
        throw err;
      }

      let errorMessage = 'Failed to fetch secret';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;

        if (status === 404) {
          errorMessage = `Secret "${secretName}" not found`;
          const vaultName = vaultUrl.match(/https:\/\/([^.]+)\.vault\.azure\.net/)?.[1];
          errorTip = [
            'Verify the secret exists in Azure Key Vault',
            vaultName
              ? `Azure Portal: https://portal.azure.com/#view/Microsoft_Azure_KeyVault/ObjectMenuBlade/~/secrets/objectId/${vaultName}`
              : 'Check Azure Portal: https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.KeyVault%2Fvaults',
          ].join('\n');
        } else if (status === 403) {
          errorMessage = `Permission denied accessing secret "${secretName}"`;
          errorTip = [
            'Ensure your service principal has the required permissions',
            'Required Key Vault access policy or RBAC role:',
            '  - Access Policy: "Get" permission for secrets',
            '  - RBAC: "Key Vault Secrets User" role',
            'Learn more: https://learn.microsoft.com/en-us/azure/key-vault/general/assign-access-policy',
          ].join('\n');
        } else if (status === 401) {
          errorMessage = 'Authentication failed';
          errorTip = 'Your access token may have expired or is invalid. Try again.';
        } else {
          try {
            const errorBody = await err.response.json();
            errorMessage = `Azure Key Vault error: ${errorBody.error?.message || errorBody.message || err.message}`;
          } catch {
            errorMessage = `Azure Key Vault error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error: ${err.message}`;
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
    }
  }

  /** extract a key from a JSON-encoded secret value, or return the raw value if no key specified */
  extractJsonKeyFromSecret(rawValue: string, jsonKey?: string): string {
    if (!jsonKey) return rawValue;

    try {
      const parsed = JSON.parse(rawValue);
      if (!(jsonKey in parsed)) {
        throw new ResolutionError(`Key "${jsonKey}" not found in secret JSON`, {
          tip: `Available keys: ${Object.keys(parsed).join(', ')}`,
        });
      }
      return String(parsed[jsonKey]);
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      throw new ResolutionError(`Failed to parse secret as JSON: ${err instanceof Error ? err.message : String(err)}`, {
        tip: 'Ensure the secret value is valid JSON when extracting a specific key',
      });
    }
  }

  async getSecret(secretRef: string, jsonKey?: string): Promise<string> {
    const rawValue = await this.fetchSecretValue(secretRef);
    return this.extractJsonKeyFromSecret(rawValue, jsonKey);
  }

  // App Configuration --------------------------------------------------------

  private async appConfigRequest<T>(pathAndQuery: string): Promise<T> {
    const endpoint = this.appConfigStoreEndpoint;
    if (!endpoint) {
      throw new SchemaError(`Azure plugin instance "${this.id}" has no App Configuration store configured`, {
        tip: 'Add appConfigEndpoint="https://<store>.azconfig.io" (or appConfigConnectionString=...) to your @initAzure() call',
      });
    }
    // resolve against the endpoint so @nextLink values (relative or absolute) both work
    const url = new URL(pathAndQuery, `${endpoint}/`);
    const headers: Record<string, string> = {};
    if (this.appConfigConnection) {
      Object.assign(headers, signAppConfigRequest(this.appConfigConnection, 'GET', url));
    } else {
      headers.Authorization = `Bearer ${await this.getAccessToken(APP_CONFIG_RESOURCE)}`;
    }
    return ky.get(url, { headers }).json<T>();
  }

  private async handleAppConfigError(err: any, action: string, subject: string): Promise<never> {
    if (err instanceof ResolutionError || err instanceof SchemaError) throw err;

    let errorMessage = `Failed ${action} Azure App Configuration ${subject}`;
    let errorTip: string | undefined;

    if (err.response) {
      const status = err.response.status;
      if (status === 404) {
        errorMessage = `Azure App Configuration ${subject} not found`;
        errorTip = [
          'Verify the key and label exist in your App Configuration store',
          `List settings: az appconfig kv list --endpoint ${this.appConfigStoreEndpoint} --auth-mode login`,
        ].join('\n');
      } else if (status === 403) {
        errorMessage = `Permission denied ${action} Azure App Configuration ${subject}`;
        errorTip = [
          'Ensure your identity has read access to the App Configuration store',
          '  - RBAC: "App Configuration Data Reader" role',
          'Learn more: https://learn.microsoft.com/en-us/azure/azure-app-configuration/concept-enable-rbac',
        ].join('\n');
      } else if (status === 401) {
        errorMessage = 'Azure App Configuration authentication failed';
        errorTip = this.appConfigConnection
          ? 'Verify the App Configuration connection string (access key) is valid and not revoked'
          : 'Your access token may have expired or is invalid. Try again.';
      } else {
        try {
          const errorBody = await err.response.json();
          errorMessage = `Azure App Configuration error ${action} ${subject}: ${errorBody.detail || errorBody.title || err.message}`;
        } catch {
          errorMessage = `Azure App Configuration error ${action} ${subject} (HTTP ${status})`;
        }
      }
    } else if (err.message) {
      errorMessage = `Network error ${action} Azure App Configuration ${subject}: ${err.message}`;
    }

    throw new ResolutionError(errorMessage, { tip: errorTip });
  }

  /**
   * Turn a setting into its final string value. Key Vault references are dereferenced
   * using the instance's Key Vault credentials; everything else (including feature
   * flags, which are JSON) is returned verbatim.
   */
  private async settingValue(setting: AppConfigSetting): Promise<string> {
    if (hasContentType(setting, KEY_VAULT_REF_CONTENT_TYPE)) {
      let uri: unknown;
      try {
        uri = JSON.parse(setting.value || '').uri;
      } catch {
        throw new ResolutionError(`Setting "${setting.key}" is a Key Vault reference but its value is not valid JSON`);
      }
      if (typeof uri !== 'string' || !uri) {
        throw new ResolutionError(`Setting "${setting.key}" is a Key Vault reference without a "uri"`);
      }
      const { vaultUrl, secretName, version } = parseKeyVaultSecretUri(uri);
      debug(`Dereferencing Key Vault reference for setting "${setting.key}" -> ${uri}`);
      return this.fetchSecretFromVault(vaultUrl, secretName, version);
    }
    return setting.value ?? '';
  }

  getSetting(key: string, label?: string): Promise<string> {
    return this.dedupeFetch(`appconfig:${JSON.stringify([key, label ?? null])}`, () => this._getSetting(key, label));
  }

  private async _getSetting(key: string, label?: string): Promise<string> {
    const query = new URLSearchParams({ 'api-version': APP_CONFIG_API_VERSION });
    if (label !== undefined) query.set('label', label);
    const subject = `setting "${key}"${label !== undefined ? ` (label "${label}")` : ''}`;
    try {
      debug(`Fetching App Configuration ${subject}`);
      const setting = await this.appConfigRequest<AppConfigSetting>(`/kv/${encodeURIComponent(key)}?${query}`);
      return await this.settingValue(setting);
    } catch (err) {
      return this.handleAppConfigError(err, 'reading', subject);
    }
  }

  /** list settings matching the filters and return them as a JSON object string (for @setValuesBulk) */
  async listSettings(keyFilter: string, labelFilter: string, trimKeyPrefix?: string): Promise<string> {
    const query = new URLSearchParams({
      key: keyFilter,
      label: labelFilter,
      'api-version': APP_CONFIG_API_VERSION,
    });
    const subject = `settings (key filter "${keyFilter}", label filter ${JSON.stringify(labelFilter)})`;
    try {
      debug(`Listing App Configuration ${subject}`);
      const settings: Array<AppConfigSetting> = [];
      let next: string | undefined = `/kv?${query}`;
      while (next) {
        const page: AppConfigListPage = await this.appConfigRequest<AppConfigListPage>(next);
        settings.push(...(page.items || []));
        next = page['@nextLink'] || undefined;
      }

      const keys = new Set<string>();
      const entries = settings.map((setting) => {
        let key = setting.key;
        if (trimKeyPrefix && key.startsWith(trimKeyPrefix)) key = key.slice(trimKeyPrefix.length);
        if (keys.has(key)) {
          throw new ResolutionError(`Multiple App Configuration settings map to key "${key}"`, {
            tip: 'Use a narrower keyFilter or labelFilter, or a different trimKeyPrefix',
          });
        }
        keys.add(key);
        return { key, setting };
      });

      const values: Record<string, string> = {};
      await Promise.all(entries.map(async ({ key, setting }) => {
        values[key] = await this.settingValue(setting);
      }));
      debug(`Loaded ${entries.length} App Configuration settings`);
      return JSON.stringify(values);
    } catch (err) {
      return this.handleAppConfigError(err, 'listing', subject);
    }
  }
}

const pluginInstances: Record<string, AzurePluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initAzure',
  description: 'Initialize an Azure plugin instance for the azureSecret() and azureAppConfig() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');

    // Validate id is static
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    if (!objArgs.vaultUrl && !objArgs.appConfigEndpoint && !objArgs.appConfigConnectionString) {
      throw new SchemaError('At least one of vaultUrl, appConfigEndpoint, or appConfigConnectionString is required', {
        tip: [
          'Key Vault: @initAzure(vaultUrl="https://<vault>.vault.azure.net/")',
          'App Configuration: @initAzure(appConfigEndpoint="https://<store>.azconfig.io")',
        ].join('\n'),
      });
    }

    pluginInstances[id] = new AzurePluginInstance(id);

    return {
      id,
      cacheTtlResolver: objArgs.cacheTtl,
      vaultUrlResolver: objArgs.vaultUrl,
      appConfigEndpointResolver: objArgs.appConfigEndpoint,
      appConfigConnectionStringResolver: objArgs.appConfigConnectionString,
      defaultLabelResolver: objArgs.defaultLabel,
      authorityHostResolver: objArgs.authorityHost,
      tenantIdResolver: objArgs.tenantId,
      clientIdResolver: objArgs.clientId,
      clientSecretResolver: objArgs.clientSecret,
      oidcTokenResolver: objArgs.oidcToken,
    };
  },
  async execute({
    id,
    cacheTtlResolver,
    vaultUrlResolver,
    appConfigEndpointResolver,
    appConfigConnectionStringResolver,
    defaultLabelResolver,
    authorityHostResolver,
    tenantIdResolver,
    clientIdResolver,
    clientSecretResolver,
    oidcTokenResolver,
  }) {
    pluginInstances[id].setConfig({
      vaultUrl: await vaultUrlResolver?.resolve(),
      appConfigEndpoint: await appConfigEndpointResolver?.resolve(),
      appConfigConnectionString: await appConfigConnectionStringResolver?.resolve(),
      defaultLabel: await defaultLabelResolver?.resolve(),
      authorityHost: await authorityHostResolver?.resolve(),
      tenantId: await tenantIdResolver?.resolve(),
      clientId: await clientIdResolver?.resolve(),
      clientSecret: await clientSecretResolver?.resolve(),
      oidcToken: await oidcTokenResolver?.resolve(),
    });
    const cacheTtl = await resolveCacheTtl(cacheTtlResolver);
    if (cacheTtl !== undefined) {
      pluginInstances[id].cacheTtl = cacheTtl;
    }
  },
});

plugin.registerDataType({
  name: 'azureTenantId',
  sensitive: false,
  typeDescription: 'Azure AD tenant ID (directory ID) for authentication',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'How to find your Azure AD tenant ID',
      url: 'https://learn.microsoft.com/en-us/azure/active-directory/fundamentals/how-to-find-tenant',
    },
  ],
  async validate(val): Promise<true> {
    // Azure tenant IDs are UUIDs
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      throw new ValidationError('Must be a valid UUID format (e.g., 12345678-1234-1234-1234-123456789012)');
    }
    return true;
  },
});

plugin.registerDataType({
  name: 'azureClientId',
  sensitive: false,
  typeDescription: 'Azure service principal application (client) ID',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'Creating a service principal',
      url: 'https://learn.microsoft.com/en-us/azure/active-directory/develop/howto-create-service-principal-portal',
    },
  ],
  async validate(val): Promise<true> {
    // Azure client IDs are UUIDs
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      throw new ValidationError('Must be a valid UUID format (e.g., 12345678-1234-1234-1234-123456789012)');
    }
    return true;
  },
});

plugin.registerDataType({
  name: 'azureClientSecret',
  sensitive: true,
  typeDescription: 'Azure service principal client secret (password)',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'Creating a service principal',
      url: 'https://learn.microsoft.com/en-us/azure/active-directory/develop/howto-create-service-principal-portal',
    },
  ],
});

plugin.registerDataType({
  name: 'azureAppConfigConnectionString',
  sensitive: true,
  internal: true,
  typeDescription: 'Azure App Configuration access key connection string (Endpoint=...;Id=...;Secret=...)',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'App Configuration access keys',
      url: 'https://learn.microsoft.com/en-us/azure/azure-app-configuration/howto-connect-app-configuration-connection-string',
    },
  ],
  async validate(val): Promise<true> {
    for (const part of ['Endpoint', 'Id', 'Secret']) {
      if (!new RegExp(`(^|;)\\s*${part}=`, 'i').test(val)) {
        throw new ValidationError(`Must contain "${part}=" (expected format: Endpoint=...;Id=...;Secret=...)`);
      }
    }
    return true;
  },
});

function getPluginInstance(instanceId: string, resolverName: string): AzurePluginInstance {
  if (!Object.values(pluginInstances).length) {
    throw new SchemaError('No Azure plugin instances found', {
      tip: 'Initialize at least one Azure plugin instance using the @initAzure root decorator',
    });
  }

  const selectedInstance = pluginInstances[instanceId];
  if (selectedInstance) return selectedInstance;

  if (instanceId === '_default') {
    throw new SchemaError('Azure plugin instance (without id) not found', {
      tip: [
        'Either remove the `id` param from your @initAzure call',
        `or use \`${resolverName}(id, ...)\` to select an instance by id.`,
        `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
      ].join('\n'),
    });
  }
  throw new SchemaError(`Azure plugin instance id "${instanceId}" not found`, {
    tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
  });
}

/** shared arg parsing for azureSecret() / azureAppConfig(): 0 args = infer, 1 arg = name, 2 args = instance id + name */
function parseInstanceAndNameArgs(
  resolverCtx: { arrArgs?: Array<Resolver> },
  resolverName: string,
  inferFromItemKey: (itemKey: string) => string,
): { instanceId: string; nameResolver?: Resolver; inferredName?: string } {
  const arrArgs = resolverCtx.arrArgs || [];
  let instanceId = '_default';
  let nameResolver: Resolver | undefined;
  let inferredName: string | undefined;

  if (arrArgs.length === 0) {
    const parent = (resolverCtx as any).parent;
    const itemKey = parent?.key || '';
    if (!itemKey) {
      throw new SchemaError(`Cannot infer name for ${resolverName}() - no item key available`, {
        tip: `Either provide a name as an argument: ${resolverName}("name"), or use this resolver on a config item with a key`,
      });
    }
    inferredName = inferFromItemKey(itemKey);
    debug(`Auto-inferred ${resolverName}() name from item key "${itemKey}": "${inferredName}"`);
  } else if (arrArgs.length === 1) {
    nameResolver = arrArgs[0];
  } else if (arrArgs.length === 2) {
    if (!(arrArgs[0].isStatic)) {
      throw new SchemaError('Expected instance id to be a static value');
    }
    instanceId = String(arrArgs[0].staticValue);
    nameResolver = arrArgs[1];
  } else {
    throw new SchemaError('Expected 0, 1, or 2 args');
  }

  getPluginInstance(instanceId, resolverName);
  return { instanceId, nameResolver, inferredName };
}

async function resolveOptionalString(resolver: Resolver | undefined, label: string): Promise<string | undefined> {
  if (!resolver) return undefined;
  const value = await resolver.resolve();
  if (typeof value !== 'string') throw new SchemaError(`Expected ${label} to resolve to a string`);
  return value;
}

plugin.registerResolverFunction({
  name: 'azureSecret',
  label: 'Fetch secret from Azure Key Vault',
  icon: AZURE_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    // Convert UPPER_SNAKE_CASE to lower-kebab-case (Key Vault does not allow underscores)
    // e.g., DATABASE_URL -> database-url
    const parsed = parseInstanceAndNameArgs(this, 'azureSecret', (itemKey) => itemKey.toLowerCase().replace(/_/g, '-'));
    return {
      instanceId: parsed.instanceId,
      secretRefResolver: parsed.nameResolver,
      inferredSecretName: parsed.inferredName,
      // Named modifiers: version=, key=
      versionResolver: this.objArgs?.version,
      keyResolver: this.objArgs?.key,
    };
  },
  async resolve({
    instanceId, secretRefResolver, inferredSecretName, versionResolver, keyResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let secretRef: string;
    if (inferredSecretName) {
      secretRef = inferredSecretName;
    } else if (secretRefResolver) {
      const resolvedRef = await secretRefResolver.resolve();
      if (typeof resolvedRef !== 'string') {
        throw new SchemaError('Expected secret reference to resolve to a string');
      }
      secretRef = resolvedRef;
    } else {
      throw new SchemaError('Expected either a secret name argument or an item key to infer from');
    }

    // Parse #key suffix for JSON key extraction (e.g., "my-secret#password")
    let jsonKey: string | undefined;
    const hashIndex = secretRef.indexOf('#');
    if (hashIndex !== -1) {
      jsonKey = secretRef.substring(hashIndex + 1);
      secretRef = secretRef.substring(0, hashIndex);
    }

    // Named key= param takes precedence over #key suffix in the ref string
    if (keyResolver) {
      const keyValue = await keyResolver.resolve();
      if (typeof keyValue !== 'string') throw new SchemaError('Expected key to resolve to a string');
      jsonKey = keyValue;
    }

    // Named version= param takes precedence over @version suffix in the ref string
    if (versionResolver) {
      const version = await versionResolver.resolve();
      if (typeof version !== 'string') throw new SchemaError('Expected version to resolve to a string');
      // Strip any existing @version suffix before appending
      secretRef = `${secretRef.split('@')[0]}@${version}`;
    }

    // check cache if cacheTtl is configured and cache is available
    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      // store the full secret value, then apply jsonKey extraction per lookup
      // (avoids collisions between azureSecret("x#foo") and azureSecret("x#bar"))
      const cacheKey = `azureSecret:${instanceId}:${selectedInstance.cacheKeyIdentity}:${secretRef}`;
      const rawValue = await pluginCache.getOrSet(
        cacheKey,
        selectedInstance.cacheTtl,
        async () => await selectedInstance.fetchSecretValue(secretRef),
      );
      if (typeof rawValue !== 'string') {
        throw new ResolutionError('Cached Azure Key Vault secret value has unexpected type (expected string)');
      }
      return selectedInstance.extractJsonKeyFromSecret(rawValue, jsonKey);
    }

    const secretValue = await selectedInstance.getSecret(secretRef, jsonKey);
    return secretValue;
  },
});

plugin.registerResolverFunction({
  name: 'azureAppConfig',
  label: 'Fetch setting from Azure App Configuration',
  icon: AZURE_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    // App Configuration keys allow underscores, so the item key is used verbatim
    const parsed = parseInstanceAndNameArgs(this, 'azureAppConfig', (itemKey) => itemKey);
    return {
      instanceId: parsed.instanceId,
      keyResolver: parsed.nameResolver,
      inferredKey: parsed.inferredName,
      labelResolver: this.objArgs?.label,
    };
  },
  async resolve({
    instanceId, keyResolver, inferredKey, labelResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    const key = inferredKey ?? await resolveOptionalString(keyResolver, 'setting key');
    if (!key) throw new SchemaError('Expected either a setting key argument or an item key to infer from');

    // label= overrides the instance's defaultLabel; an explicit empty label means "no label"
    let label: string | undefined;
    if (labelResolver) {
      label = await resolveOptionalString(labelResolver, 'label') || undefined;
    } else {
      label = selectedInstance.appConfigDefaultLabel;
    }

    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      const cacheKey = `azureAppConfig:${instanceId}:${selectedInstance.appConfigCacheKeyIdentity}:${JSON.stringify([key, label ?? null])}`;
      const value = await pluginCache.getOrSet(
        cacheKey,
        selectedInstance.cacheTtl,
        async () => await selectedInstance.getSetting(key, label),
      );
      if (typeof value !== 'string') {
        throw new ResolutionError('Cached Azure App Configuration value has unexpected type (expected string)');
      }
      return value;
    }

    return selectedInstance.getSetting(key, label);
  },
});

plugin.registerResolverFunction({
  name: 'azureAppConfigBulk',
  label: 'Load settings from Azure App Configuration as JSON',
  icon: AZURE_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 1,
  },
  process() {
    let instanceId = '_default';
    if (this.arrArgs?.length) {
      if (!this.arrArgs[0].isStatic) throw new SchemaError('Expected instance id to be a static value');
      instanceId = String(this.arrArgs[0].staticValue);
    }
    getPluginInstance(instanceId, 'azureAppConfigBulk');
    return {
      instanceId,
      keyFilterResolver: this.objArgs?.keyFilter,
      labelFilterResolver: this.objArgs?.labelFilter,
      trimKeyPrefixResolver: this.objArgs?.trimKeyPrefix,
    };
  },
  async resolve({
    instanceId, keyFilterResolver, labelFilterResolver, trimKeyPrefixResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    const keyFilter = await resolveOptionalString(keyFilterResolver, 'keyFilter') || '*';
    // default to the instance's defaultLabel, otherwise only unlabeled settings
    const labelFilter = await resolveOptionalString(labelFilterResolver, 'labelFilter')
      || selectedInstance.appConfigDefaultLabel
      || NO_LABEL_FILTER;
    const trimKeyPrefix = await resolveOptionalString(trimKeyPrefixResolver, 'trimKeyPrefix') || undefined;

    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      const cacheKey = `azureAppConfigBulk:${instanceId}:${selectedInstance.appConfigCacheKeyIdentity}:${JSON.stringify([keyFilter, labelFilter, trimKeyPrefix ?? null])}`;
      const value = await pluginCache.getOrSet(
        cacheKey,
        selectedInstance.cacheTtl,
        async () => await selectedInstance.listSettings(keyFilter, labelFilter, trimKeyPrefix),
      );
      if (typeof value !== 'string') {
        throw new ResolutionError('Cached Azure App Configuration bulk value has unexpected type (expected string)');
      }
      return value;
    }

    return selectedInstance.listSettings(keyFilter, labelFilter, trimKeyPrefix);
  },
});

// Anonymous, non-sensitive usage signals. Strictly sanitized before send.
plugin.registerTelemetryAttributes(() => {
  const instances = Object.values(pluginInstances);
  const authMethods = new Set(instances.map((i) => i.telemetryAuthMethod));
  return {
    // standard attributes
    instance_count: instances.length,
    cache_enabled: instances.some((i) => i.cacheTtl != null),
    // custom attributes
    key_vault_enabled: instances.some((i) => i.hasKeyVault),
    app_config_enabled: instances.some((i) => i.hasAppConfig),
    auth_service_principal: authMethods.has('service_principal'),
    auth_oidc_federated: authMethods.has('oidc_federated'),
    auth_connection_string: instances.some((i) => i.hasAppConfigConnectionString),
    auth_ambient: authMethods.has('ambient'),
  };
});
