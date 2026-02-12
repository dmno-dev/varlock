import { Resolver } from 'varlock/plugin-lib';
import ky from 'ky';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const AZURE_ICON = 'skill-icons:azure-dark';

plugin.name = 'azure';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = AZURE_ICON;

interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

class AzurePluginInstance {
  private vaultUrl?: string;
  private tenantId?: string;
  private clientId?: string;
  private clientSecret?: string;
  private cachedToken?: CachedToken;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(
    vaultUrl?: any,
    tenantId?: any,
    clientId?: any,
    clientSecret?: any,
  ) {
    this.vaultUrl = vaultUrl ? String(vaultUrl) : undefined;
    this.tenantId = tenantId ? String(tenantId) : undefined;
    this.clientId = clientId ? String(clientId) : undefined;
    this.clientSecret = clientSecret ? String(clientSecret) : undefined;
    debug(
      'azure instance',
      this.id,
      'set auth - vaultUrl:',
      this.vaultUrl,
      'hasTenantId:',
      !!this.tenantId,
      'hasClientId:',
      !!this.clientId,
      'hasClientSecret:',
      !!this.clientSecret,
    );
  }

  private async getAzureCliToken(): Promise<string | undefined> {
    // Try the older accessTokens.json format first
    try {
      const tokenCachePath = join(homedir(), '.azure', 'accessTokens.json');
      const tokenCacheContent = await readFile(tokenCachePath, 'utf-8');
      const tokens = JSON.parse(tokenCacheContent);

      // Find a valid token for vault.azure.net
      const now = new Date();
      const validToken = tokens.find((t: any) => {
        const expiresOn = new Date(t.expiresOn);
        return t.resource === 'https://vault.azure.net'
          && expiresOn > now
          && t.tokenType === 'Bearer';
      });

      if (validToken) {
        debug('Found valid Azure CLI token for vault.azure.net in accessTokens.json');

        // Cache it
        const expiresOn = new Date(validToken.expiresOn);
        this.cachedToken = {
          token: validToken.accessToken,
          expiresAt: expiresOn.getTime(),
        };

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

      // Find a valid token for vault.azure.net
      for (const [_key, token] of Object.entries(accessTokens) as Array<[string, any]>) {
        if (token.target?.includes('https://vault.azure.net/.default')
          && token.expires_on > now
          && token.secret) {
          debug('Found valid Azure CLI token from MSAL cache');

          // Cache it
          this.cachedToken = {
            token: token.secret,
            expiresAt: token.expires_on * 1000,
          };

          return token.secret;
        }
      }
    } catch (err) {
      debug('Could not read MSAL token cache:', err);
    }

    // If no cached token found, try to get one directly from az CLI
    try {
      debug('No cached token found, attempting to get token from az CLI directly');
      const result = execSync('az account get-access-token --resource https://vault.azure.net', {
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

        this.cachedToken = {
          token: tokenData.accessToken,
          expiresAt,
        };

        return tokenData.accessToken;
      }
    } catch (err) {
      debug('Could not get token from az CLI:', err);
    }

    debug('No valid Azure CLI token found');
    return undefined;
  }

  private async getManagedIdentityToken(): Promise<string | undefined> {
    try {
      debug('Attempting to get token from Managed Identity (IMDS)');

      // Azure Instance Metadata Service endpoint
      const imdsEndpoint = 'http://169.254.169.254/metadata/identity/oauth2/token';

      const response = await ky.get(imdsEndpoint, {
        searchParams: {
          'api-version': '2018-02-01',
          resource: 'https://vault.azure.net',
        },
        headers: {
          Metadata: 'true',
        },
        timeout: 3000, // Quick timeout - if we're not on Azure, this will fail fast
      }).json<AzureTokenResponse>();

      if (response.access_token && response.expires_in) {
        debug('Successfully obtained token from Managed Identity');

        // Cache the token
        this.cachedToken = {
          token: response.access_token,
          expiresAt: Date.now() + (response.expires_in * 1000),
        };

        return response.access_token;
      }
    } catch (err) {
      debug('Managed Identity not available (not running on Azure or identity not assigned)');
    }

    return undefined;
  }

  private async getAccessToken(): Promise<string> {
    // Check if we have a cached token that's still valid (with 5 min buffer)
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
      debug('Using cached Azure access token');
      return this.cachedToken.token;
    }

    // First priority: Use explicitly provided service principal credentials
    const tenantId = this.tenantId;
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;

    // If all credentials are explicitly provided, use them
    if (tenantId && clientId && clientSecret) {
      debug('Using explicitly provided service principal credentials');
      return this.getServicePrincipalToken(tenantId, clientId, clientSecret);
    }

    // Second priority: Try Managed Identity (for Azure-hosted apps)
    const managedIdentityToken = await this.getManagedIdentityToken();
    if (managedIdentityToken) {
      debug('Using Managed Identity authentication');
      return managedIdentityToken;
    }

    // Third priority: Fall back to Azure CLI authentication
    const cliToken = await this.getAzureCliToken();
    if (cliToken) {
      debug('Using Azure CLI authentication');
      return cliToken;
    }

    // No credentials available
    throw new SchemaError('Azure credentials are required', {
      tip: [
        'Option 1: Use Azure CLI (easiest for local development)',
        '  - Run: az login',
        '  - This will automatically work with varlock',
        '',
        'Option 2: Use Managed Identity (for Azure-hosted apps)',
        '  - Enable system-assigned or user-assigned managed identity on your Azure resource',
        '  - Grant the identity "Key Vault Secrets User" role on your Key Vault',
        '  - No credentials needed in your code!',
        '',
        'Option 3: Provide service principal credentials via @initAzure():',
        '  - tenantId: Your Azure AD tenant ID',
        '  - clientId: Your service principal application (client) ID',
        '  - clientSecret: Your service principal client secret',
      ].join('\n'),
    });
  }

  private async getServicePrincipalToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
    try {
      debug('Fetching new Azure access token with service principal');
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

      const response = await ky.post(tokenUrl, {
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://vault.azure.net/.default',
        }),
      }).json<AzureTokenResponse>();

      // Cache the token (expires_in is in seconds)
      this.cachedToken = {
        token: response.access_token,
        expiresAt: Date.now() + (response.expires_in * 1000),
      };

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

  async getSecret(secretRef: string): Promise<string> {
    if (!this.vaultUrl) {
      throw new SchemaError('vaultUrl is required');
    }

    try {
      // Parse secret reference: "secretName" or "secretName@version"
      const [secretName, version] = secretRef.split('@');

      const accessToken = await this.getAccessToken();

      // Build the URL - if version is specified, include it, otherwise use latest
      const secretUrl = version
        ? `${this.vaultUrl}/secrets/${secretName}/${version}?api-version=7.4`
        : `${this.vaultUrl}/secrets/${secretName}?api-version=7.4`;

      debug(`Fetching secret: ${secretName}${version ? `@${version}` : ''}`);

      const response = await ky.get(secretUrl, {
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
      // Re-throw ResolutionError as-is
      if (err instanceof ResolutionError) {
        throw err;
      }

      let errorMessage = 'Failed to fetch secret';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;
        const secretName = secretRef.split('@')[0];

        if (status === 404) {
          errorMessage = `Secret "${secretName}" not found`;
          const vaultName = this.vaultUrl?.match(/https:\/\/([^.]+)\.vault\.azure\.net/)?.[1];
          errorTip = [
            'Verify the secret exists in Azure Key Vault',
            vaultName
              ? `Azure Portal: https://portal.azure.com/#view/Microsoft_Azure_KeyVault/ObjectMenuBlade/~/secrets/objectId/${vaultName}`
              : 'Check Azure Portal: https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.KeyVault%2Fvaults',
          ].join('\n');
        } else if (status === 403) {
          errorMessage = `Permission denied accessing secret "${secretRef}"`;
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
}

const pluginInstances: Record<string, AzurePluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initAzure',
  description: 'Initialize an Azure Key Vault plugin instance for azureSecret() resolver',
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

    // vaultUrl is required
    if (!objArgs.vaultUrl) {
      throw new SchemaError('vaultUrl parameter is required');
    }

    pluginInstances[id] = new AzurePluginInstance(id);

    return {
      id,
      vaultUrlResolver: objArgs.vaultUrl,
      tenantIdResolver: objArgs.tenantId,
      clientIdResolver: objArgs.clientId,
      clientSecretResolver: objArgs.clientSecret,
    };
  },
  async execute({
    id,
    vaultUrlResolver,
    tenantIdResolver,
    clientIdResolver,
    clientSecretResolver,
  }) {
    const vaultUrl = await vaultUrlResolver.resolve();
    const tenantId = await tenantIdResolver?.resolve();
    const clientId = await clientIdResolver?.resolve();
    const clientSecret = await clientSecretResolver?.resolve();
    pluginInstances[id].setAuth(vaultUrl, tenantId, clientId, clientSecret);
  },
});

plugin.registerDataType({
  name: 'azureTenantId',
  sensitive: true,
  typeDescription: 'Azure AD tenant ID (directory ID) for authentication',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'How to find your Azure AD tenant ID',
      url: 'https://learn.microsoft.com/en-us/azure/active-directory/fundamentals/how-to-find-tenant',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
    // Azure tenant IDs are UUIDs
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      throw new ValidationError('Must be a valid UUID format (e.g., 12345678-1234-1234-1234-123456789012)');
    }
    return true;
  },
});

plugin.registerDataType({
  name: 'azureClientId',
  sensitive: true,
  typeDescription: 'Azure service principal application (client) ID',
  icon: AZURE_ICON,
  docs: [
    {
      description: 'Creating a service principal',
      url: 'https://learn.microsoft.com/en-us/azure/active-directory/develop/howto-create-service-principal-portal',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
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
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
    // Azure client secrets don't have a specific format, just check it's not empty
    if (val.length === 0) {
      throw new ValidationError('Must not be empty');
    }
    return true;
  },
});

plugin.registerResolverFunction({
  name: 'azureSecret',
  label: 'Fetch secret from Azure Key Vault',
  icon: AZURE_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId: string;
    let secretRefResolver: Resolver | undefined;
    let inferredSecretName: string | undefined;

    if (!this.arrArgs || this.arrArgs.length === 0) {
      // No arguments - infer secret name from item name
      instanceId = '_default';
      // Convert UPPER_SNAKE_CASE to lower-kebab-case
      // e.g., DATABASE_URL -> database-url

      // Access the item key from this.parent (which should be a ConfigItem)
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Cannot infer secret name - no item key available', {
          tip: 'Either provide a secret name as an argument: azureSecret("secret-name"), or use this resolver on a config item with a key',
        });
      }
      inferredSecretName = itemKey.toLowerCase().replace(/_/g, '-');
      debug(`Auto-inferred secret name from item key "${itemKey}": "${inferredSecretName}"`);
    } else if (this.arrArgs.length === 1) {
      instanceId = '_default';
      secretRefResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('Expected instance id to be a static value');
      } else {
        instanceId = String(this.arrArgs[0].staticValue);
      }
      secretRefResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Azure Key Vault plugin instances found', {
        tip: 'Initialize at least one Azure plugin instance using the @initAzure root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Azure Key Vault plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initAzure call',
            'or use `azureSecret(id, secretName)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Azure Key Vault plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, secretRefResolver, inferredSecretName };
  },
  async resolve({ instanceId, secretRefResolver, inferredSecretName }) {
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

    const secretValue = await selectedInstance.getSecret(secretRef);
    return secretValue;
  },
});
