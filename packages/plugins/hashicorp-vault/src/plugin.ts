import { Resolver } from 'varlock/plugin-lib';
import ky from 'ky';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const VAULT_ICON = 'simple-icons:vault';

plugin.name = 'vault';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = VAULT_ICON;

const FIX_AUTH_TIP = [
  'Verify your Vault credentials are configured correctly. Use one of the following options:',
  '  1. Provide a token explicitly via @initHcpVault(token=$VAULT_TOKEN)',
  '  2. Use AppRole auth via @initHcpVault(roleId=..., secretId=...)',
  '  3. Login via the vault CLI (vault login) - the ~/.vault-token file will be used automatically',
].join('\n');

interface CachedToken {
  token: string;
  expiresAt: number;
}

class VaultPluginInstance {
  private url?: string;
  private namespace?: string;
  private token?: string;
  private roleId?: string;
  private secretId?: string;
  private defaultPath?: string;
  private pathPrefix?: string;
  private cachedToken?: CachedToken;

  constructor(
    readonly id: string,
  ) {}

  setAuth(
    url?: any,
    namespace?: any,
    token?: any,
    roleId?: any,
    secretId?: any,
    defaultPath?: any,
    pathPrefix?: any,
  ) {
    this.url = url ? String(url).replace(/\/+$/, '') : undefined;
    this.namespace = namespace ? String(namespace) : undefined;
    this.token = token ? String(token) : undefined;
    this.roleId = roleId ? String(roleId) : undefined;
    this.secretId = secretId ? String(secretId) : undefined;
    this.defaultPath = defaultPath ? String(defaultPath) : undefined;
    this.pathPrefix = pathPrefix ? String(pathPrefix) : undefined;
    debug(
      'vault instance',
      this.id,
      'set auth - url:',
      this.url,
      'hasToken:',
      !!this.token,
      'hasRoleId:',
      !!this.roleId,
      'namespace:',
      this.namespace,
      'defaultPath:',
      this.defaultPath,
      'pathPrefix:',
      this.pathPrefix,
    );
  }

  private async getVaultToken(): Promise<string> {
    // Check cached token (with 30s buffer)
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) {
      debug('Using cached Vault token');
      return this.cachedToken.token;
    }

    // 1. Explicit token
    if (this.token) {
      debug('Using explicitly provided Vault token');
      return this.token;
    }

    // 2. AppRole auth
    if (this.roleId && this.secretId) {
      return this.loginWithAppRole();
    }

    // 3. Vault/OpenBao CLI token helper files
    for (const tokenFile of ['.vault-token', '.bao-token']) {
      try {
        const tokenPath = join(homedir(), tokenFile);
        const fileToken = (await readFile(tokenPath, 'utf-8')).trim();
        if (fileToken) {
          debug(`Using token from ~/${tokenFile}`);
          return fileToken;
        }
      } catch {
        debug(`Could not read ~/${tokenFile}`);
      }
    }

    throw new SchemaError('No Vault authentication found', {
      tip: FIX_AUTH_TIP,
    });
  }

  private async loginWithAppRole(): Promise<string> {
    if (!this.url) throw new SchemaError('Vault URL is required for AppRole auth');

    try {
      const headers: Record<string, string> = {};
      if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;

      const response = await ky.post(`${this.url}/v1/auth/approle/login`, {
        json: { role_id: this.roleId, secret_id: this.secretId },
        headers,
      }).json<{ auth: { client_token: string; lease_duration: number } }>();

      const clientToken = response.auth.client_token;
      const leaseDuration = response.auth.lease_duration;

      this.cachedToken = {
        token: clientToken,
        expiresAt: Date.now() + (leaseDuration * 1000),
      };

      debug('Successfully authenticated with AppRole');
      return clientToken;
    } catch (err: any) {
      let errorMessage = 'AppRole authentication failed';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;
        if (status === 400) {
          errorMessage = 'AppRole login failed - invalid role_id or secret_id';
          errorTip = [
            'Verify your AppRole credentials:',
            '  - role_id: The UUID of the AppRole role',
            '  - secret_id: A valid secret ID for the role',
            'Generate a new secret_id: vault write -f auth/approle/role/<role>/secret-id',
          ].join('\n');
        } else if (status === 403) {
          errorMessage = 'AppRole login denied - insufficient permissions';
          errorTip = 'Ensure the AppRole auth method is enabled and the role exists';
        } else {
          errorMessage = `AppRole login failed (HTTP ${status})`;
        }
      } else if (err.message) {
        errorMessage = `AppRole login error: ${err.message}`;
      }

      throw new SchemaError(errorMessage, { tip: errorTip });
    }
  }

  buildPath(explicitPath?: string): string {
    let basePath: string;
    if (explicitPath) {
      basePath = explicitPath;
    } else if (this.defaultPath) {
      basePath = this.defaultPath;
    } else {
      throw new ResolutionError('No path specified and no defaultPath configured', {
        tip: 'Either provide a path argument to vaultSecret() or set defaultPath in @initHcpVault()',
      });
    }

    if (this.pathPrefix) {
      const prefix = this.pathPrefix.replace(/\/+$/, '');
      const path = basePath.replace(/^\/+/, '');
      return `${prefix}/${path}`;
    }
    return basePath;
  }

  async getSecret(secretPath: string, jsonKey?: string): Promise<string> {
    if (!this.url) {
      throw new SchemaError('Vault URL is required');
    }

    const token = await this.getVaultToken();

    // Split path into mount and secret path for KV v2 API
    // e.g., "secret/apple/music" -> mount="secret", kvPath="apple/music"
    // API endpoint: GET /v1/{mount}/data/{kvPath}
    const slashIdx = secretPath.indexOf('/');
    let mount: string;
    let kvPath: string;
    if (slashIdx === -1) {
      mount = secretPath;
      kvPath = '';
    } else {
      mount = secretPath.substring(0, slashIdx);
      kvPath = secretPath.substring(slashIdx + 1);
    }

    const apiUrl = kvPath
      ? `${this.url}/v1/${mount}/data/${kvPath}`
      : `${this.url}/v1/${mount}/data`;

    const headers: Record<string, string> = { 'X-Vault-Token': token };
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;

    try {
      debug(`Fetching secret: ${secretPath}${jsonKey ? `#${jsonKey}` : ''}`);

      const response = await ky.get(apiUrl, { headers })
        .json<{ data: { data: Record<string, any>; metadata: any } }>();

      const secretData = response.data?.data;
      if (!secretData) {
        throw new ResolutionError('Secret data is empty');
      }

      // If a JSON key is specified, extract it
      if (jsonKey) {
        if (!(jsonKey in secretData)) {
          throw new ResolutionError(`Key "${jsonKey}" not found in secret`, {
            tip: `Available keys: ${Object.keys(secretData).join(', ')}`,
          });
        }
        return String(secretData[jsonKey]);
      }

      // No key specified: if single key, return its value; otherwise return JSON
      const keys = Object.keys(secretData);
      if (keys.length === 1) {
        return String(secretData[keys[0]]);
      }
      return JSON.stringify(secretData);
    } catch (err: any) {
      if (err instanceof ResolutionError) throw err;

      let errorMessage = 'Failed to fetch secret';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;

        if (status === 404) {
          errorMessage = `Secret at path "${secretPath}" not found`;
          errorTip = [
            'Verify the secret exists in Vault:',
            `  vault kv get ${secretPath}`,
            '',
            'Common issues:',
            '  - The mount point may be wrong (first path segment)',
            '  - The secret path may not exist',
            '  - KV v1 secrets use a different API format',
          ].join('\n');
        } else if (status === 403) {
          errorMessage = `Permission denied for path "${secretPath}"`;
          errorTip = [
            'Ensure your token has the correct policy. Required capability: read',
            'Example policy:',
            `  path "${mount}/data/${kvPath || '*'}" {`,
            '    capabilities = ["read"]',
            '  }',
          ].join('\n');
        } else if (status === 401) {
          errorMessage = 'Vault authentication failed';
          errorTip = [
            'Your token may be expired or invalid',
            FIX_AUTH_TIP,
          ].join('\n');
        } else if (status === 503) {
          errorMessage = 'Vault server is sealed or unavailable';
          errorTip = 'Check that the Vault server is running and unsealed';
        } else {
          try {
            const errorBody = await err.response.json();
            const errors = errorBody.errors?.join('; ') || '';
            errorMessage = `Vault error (HTTP ${status}): ${errors || err.message}`;
          } catch {
            errorMessage = `Vault error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error: ${err.message}`;
        errorTip = 'Verify the Vault URL is correct and the server is reachable';
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
    }
  }
}

const pluginInstances: Record<string, VaultPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initHcpVault',
  description: 'Initialize a HashiCorp Vault plugin instance for vaultSecret() resolver',
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

    // url is required
    if (!objArgs.url) {
      throw new SchemaError('url parameter is required', {
        tip: 'Provide your Vault server URL: @initHcpVault(url="https://vault.example.com:8200")',
      });
    }

    pluginInstances[id] = new VaultPluginInstance(id);

    return {
      id,
      urlResolver: objArgs.url,
      namespaceResolver: objArgs.namespace,
      tokenResolver: objArgs.token,
      roleIdResolver: objArgs.roleId,
      secretIdResolver: objArgs.secretId,
      defaultPathResolver: objArgs.defaultPath,
      pathPrefixResolver: objArgs.pathPrefix,
    };
  },
  async execute({
    id,
    urlResolver,
    namespaceResolver,
    tokenResolver,
    roleIdResolver,
    secretIdResolver,
    defaultPathResolver,
    pathPrefixResolver,
  }) {
    const url = await urlResolver.resolve();
    const namespace = await namespaceResolver?.resolve();
    const token = await tokenResolver?.resolve();
    const roleId = await roleIdResolver?.resolve();
    const secretId = await secretIdResolver?.resolve();
    const defaultPath = await defaultPathResolver?.resolve();
    const pathPrefix = await pathPrefixResolver?.resolve();
    pluginInstances[id].setAuth(url, namespace, token, roleId, secretId, defaultPath, pathPrefix);
  },
});

plugin.registerDataType({
  name: 'vaultToken',
  sensitive: true,
  typeDescription: 'HashiCorp Vault authentication token',
  icon: VAULT_ICON,
  docs: [
    {
      description: 'Vault Tokens',
      url: 'https://developer.hashicorp.com/vault/docs/concepts/tokens',
    },
  ], 
});

plugin.registerResolverFunction({
  name: 'vaultSecret',
  label: 'Fetch secret from HashiCorp Vault KV v2',
  icon: VAULT_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let secretRefResolver: Resolver | undefined;
    let inferredSecretRef: string | undefined;
    let keyResolver: Resolver | undefined;

    // Check for named 'key' parameter
    if (this.objArgs?.key) {
      keyResolver = this.objArgs.key;
    }

    // No args - auto-infer from parent config item key
    if (!this.arrArgs || this.arrArgs.length === 0) {
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer secret path - no parent config item key found', {
          tip: 'Either provide a secret path as an argument, or ensure this is used within a config item',
        });
      }
      inferredSecretRef = itemKey;
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
      throw new SchemaError('No Vault plugin instances found', {
        tip: 'Initialize at least one Vault instance using the @initHcpVault() root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Vault plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initHcpVault call',
            'or use `vaultSecret(id, secretRef)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Vault plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return {
      instanceId, secretRefResolver, inferredSecretRef, keyResolver,
    };
  },
  async resolve({
    instanceId, secretRefResolver, inferredSecretRef, keyResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let secretRefWithKey: string;
    if (inferredSecretRef) {
      secretRefWithKey = inferredSecretRef;
    } else if (secretRefResolver) {
      const secretRef = await secretRefResolver.resolve();
      if (typeof secretRef !== 'string') {
        throw new SchemaError('Expected secret reference to resolve to a string');
      }
      secretRefWithKey = secretRef;
    } else {
      throw new SchemaError('No secret reference provided or inferred');
    }

    // Parse for JSON key extraction (using # syntax)
    // e.g., "secret/path#KEY_NAME" -> path="secret/path", jsonKey="KEY_NAME"
    let secretPath: string;
    let jsonKey: string | undefined;
    const hashIndex = secretRefWithKey.indexOf('#');
    if (hashIndex !== -1) {
      secretPath = secretRefWithKey.substring(0, hashIndex);
      jsonKey = secretRefWithKey.substring(hashIndex + 1);
    } else {
      secretPath = secretRefWithKey;
    }

    // Named 'key' parameter takes precedence over # syntax
    if (keyResolver) {
      const keyValue = await keyResolver.resolve();
      if (typeof keyValue !== 'string') {
        throw new SchemaError('Expected key parameter to resolve to a string');
      }
      jsonKey = keyValue;
    }

    // Build the full path using pathPrefix/defaultPath
    const fullPath = selectedInstance.buildPath(secretPath);

    return await selectedInstance.getSecret(fullPath, jsonKey);
  },
});
