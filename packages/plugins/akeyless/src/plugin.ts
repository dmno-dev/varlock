import { type Resolver, plugin } from 'varlock/plugin-lib';
import ky from 'ky';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const AKEYLESS_ICON = 'simple-icons:akeyless';

plugin.name = 'akeyless';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = AKEYLESS_ICON;
plugin.standardVars = {
  initDecorator: '@initAkeyless',
  params: {
    accessId: { key: 'AKEYLESS_ACCESS_ID', dataType: 'akeylessAccessId' },
    accessKey: { key: 'AKEYLESS_ACCESS_KEY', dataType: 'akeylessAccessKey' },
  },
};

const DEFAULT_API_URL = 'https://api.akeyless.io';

const FIX_AUTH_TIP = [
  'Verify your Akeyless credentials are configured correctly:',
  '  1. Provide an API Key via @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY)',
  '  2. Ensure the Access ID starts with "p-" (API Key auth)',
  '  3. Verify the Access Key matches the Access ID in the Akeyless Console',
].join('\n');

interface CachedToken {
  token: string;
  expiresAt: number;
}

class AkeylessPluginInstance {
  private accessId?: string;
  private accessKey?: string;
  private apiUrl: string = DEFAULT_API_URL;
  private cachedToken?: CachedToken;

  constructor(
    readonly id: string,
  ) {}

  setAuth(
    accessId?: any,
    accessKey?: any,
    apiUrl?: any,
  ) {
    this.accessId = accessId ? String(accessId) : undefined;
    this.accessKey = accessKey ? String(accessKey) : undefined;
    if (apiUrl) this.apiUrl = String(apiUrl).replace(/\/+$/, '');
    debug(
      'akeyless instance',
      this.id,
      'set auth - apiUrl:',
      this.apiUrl,
      'hasAccessId:',
      !!this.accessId,
      'hasAccessKey:',
      !!this.accessKey,
    );
  }

  private async authenticate(): Promise<string> {
    // Check cached token (with 30s buffer before expiry)
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) {
      debug('Using cached Akeyless token');
      return this.cachedToken.token;
    }

    if (!this.accessId || !this.accessKey) {
      throw new SchemaError('Akeyless Access ID and Access Key are required', {
        tip: FIX_AUTH_TIP,
      });
    }

    try {
      debug('Authenticating with Akeyless API Key');

      const response = await ky.post(`${this.apiUrl}/auth`, {
        json: {
          'access-id': this.accessId,
          'access-key': this.accessKey,
          'access-type': 'access_key',
        },
      }).json<{ token: string; expiry?: number }>();

      const token = response.token;
      if (!token) {
        throw new SchemaError('Authentication succeeded but no token was returned');
      }

      // Cache the token; use expiry from response if available, otherwise default to 30 minutes
      const expiresIn = response.expiry
        ? (response.expiry * 1000) - Date.now()
        : 30 * 60 * 1000;
      this.cachedToken = {
        token,
        expiresAt: Date.now() + expiresIn,
      };

      debug('Successfully authenticated with Akeyless');
      return token;
    } catch (err: any) {
      // Re-throw our own errors as-is
      if (err instanceof SchemaError) throw err;

      let errorMessage = 'Akeyless authentication failed';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          errorMessage = 'Akeyless authentication failed - invalid credentials';
          errorTip = FIX_AUTH_TIP;
        } else {
          try {
            const errorBody = await err.response.json();
            const msg = errorBody.message || errorBody.error || '';
            errorMessage = `Akeyless auth error (HTTP ${status}): ${msg}`;
          } catch {
            errorMessage = `Akeyless auth error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Akeyless auth error: ${err.message}`;
        errorTip = 'Verify the Akeyless API URL is correct and reachable';
      }

      throw new SchemaError(errorMessage, { tip: errorTip });
    }
  }

  async getStaticSecret(secretName: string): Promise<string> {
    const token = await this.authenticate();

    try {
      debug(`Fetching static secret: ${secretName}`);

      const response = await ky.post(`${this.apiUrl}/get-secret-value`, {
        json: {
          names: [secretName],
          token,
        },
      }).json<Record<string, string>>();

      // The response is a map of { "/path/to/secret": "value" }
      const value = response[secretName];
      if (value === undefined || value === null) {
        throw new ResolutionError(`Secret "${secretName}" not found in response`, {
          tip: [
            'Verify the secret exists in Akeyless:',
            `  Secret name: ${secretName}`,
            '',
            'Common issues:',
            '  - The secret name must include the full path (e.g., "/MyFolder/MySecret")',
            '  - The secret may have been deleted or moved',
          ].join('\n'),
        });
      }

      return value;
    } catch (err: any) {
      if (err instanceof ResolutionError) throw err;

      let errorMessage = 'Failed to fetch secret from Akeyless';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;

        if (status === 404) {
          errorMessage = `Secret "${secretName}" not found`;
          errorTip = [
            'Verify the secret exists in the Akeyless Console',
            `  Secret name: ${secretName}`,
            '',
            'Ensure you are using the full path (e.g., "/MyFolder/MySecret")',
          ].join('\n');
        } else if (status === 403) {
          errorMessage = `Permission denied for secret "${secretName}"`;
          errorTip = [
            'Ensure your access credentials have read permission for this secret.',
            'Check your Access Role configuration in the Akeyless Console.',
          ].join('\n');
        } else if (status === 401) {
          errorMessage = 'Akeyless authentication token expired or invalid';
          // Clear cached token so next call re-authenticates
          this.cachedToken = undefined;
          errorTip = FIX_AUTH_TIP;
        } else {
          try {
            const errorBody = await err.response.json();
            const msg = errorBody.message || errorBody.error || '';
            errorMessage = `Akeyless error (HTTP ${status}): ${msg}`;
          } catch {
            errorMessage = `Akeyless error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error: ${err.message}`;
        errorTip = 'Verify the Akeyless API URL is correct and the service is reachable';
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
    }
  }

  async getDynamicSecret(secretName: string): Promise<string> {
    const token = await this.authenticate();

    try {
      debug(`Fetching dynamic secret: ${secretName}`);

      const response = await ky.post(`${this.apiUrl}/get-dynamic-secret-value`, {
        json: {
          name: secretName,
          token,
        },
      }).json<Record<string, any>>();

      // Dynamic secrets return structured data; return as JSON string
      return JSON.stringify(response);
    } catch (err: any) {
      if (err instanceof ResolutionError) throw err;

      let errorMessage = 'Failed to fetch dynamic secret from Akeyless';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;

        if (status === 404) {
          errorMessage = `Dynamic secret "${secretName}" not found`;
          errorTip = 'Verify the dynamic secret exists in the Akeyless Console';
        } else if (status === 403) {
          errorMessage = `Permission denied for dynamic secret "${secretName}"`;
          errorTip = 'Ensure your access credentials have permission for this dynamic secret';
        } else if (status === 401) {
          this.cachedToken = undefined;
          errorMessage = 'Akeyless authentication token expired or invalid';
          errorTip = FIX_AUTH_TIP;
        } else {
          try {
            const errorBody = await err.response.json();
            const msg = errorBody.message || errorBody.error || '';
            errorMessage = `Akeyless error (HTTP ${status}): ${msg}`;
          } catch {
            errorMessage = `Akeyless error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error: ${err.message}`;
        errorTip = 'Verify the Akeyless API URL is correct and the service is reachable';
      }

      throw new ResolutionError(errorMessage, { tip: errorTip });
    }
  }

  async getRotatedSecret(secretName: string): Promise<string> {
    const token = await this.authenticate();

    try {
      debug(`Fetching rotated secret: ${secretName}`);

      const response = await ky.post(`${this.apiUrl}/get-rotated-secret-value`, {
        json: {
          names: secretName,
          token,
        },
      }).json<{ value: Record<string, any> }>();

      const value = response.value;
      if (!value) {
        throw new ResolutionError(`Rotated secret "${secretName}" returned no value`);
      }

      // Rotated secrets return structured data; return as JSON string
      return JSON.stringify(value);
    } catch (err: any) {
      if (err instanceof ResolutionError) throw err;

      let errorMessage = 'Failed to fetch rotated secret from Akeyless';
      let errorTip: string | undefined;

      if (err.response) {
        const status = err.response.status;

        if (status === 404) {
          errorMessage = `Rotated secret "${secretName}" not found`;
          errorTip = 'Verify the rotated secret exists in the Akeyless Console';
        } else if (status === 403) {
          errorMessage = `Permission denied for rotated secret "${secretName}"`;
          errorTip = 'Ensure your access credentials have permission for this rotated secret';
        } else if (status === 401) {
          this.cachedToken = undefined;
          errorMessage = 'Akeyless authentication token expired or invalid';
          errorTip = FIX_AUTH_TIP;
        } else {
          try {
            const errorBody = await err.response.json();
            const msg = errorBody.message || errorBody.error || '';
            errorMessage = `Akeyless error (HTTP ${status}): ${msg}`;
          } catch {
            errorMessage = `Akeyless error (HTTP ${status})`;
          }
        }
      } else if (err.message) {
        errorMessage = `Network error: ${err.message}`;
        errorTip = 'Verify the Akeyless API URL is correct and the service is reachable';
      }

      throw new ResolutionError(errorMessage, { tip: errorTip });
    }
  }
}

const pluginInstances: Record<string, AkeylessPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initAkeyless',
  description: 'Initialize an Akeyless plugin instance for akeyless() resolver',
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

    // accessId is required
    if (!objArgs.accessId) {
      throw new SchemaError('accessId parameter is required', {
        tip: 'Provide your Akeyless Access ID: @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY)',
      });
    }
    // accessKey is required
    if (!objArgs.accessKey) {
      throw new SchemaError('accessKey parameter is required', {
        tip: 'Provide your Akeyless Access Key: @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY)',
      });
    }

    pluginInstances[id] = new AkeylessPluginInstance(id);

    return {
      id,
      accessIdResolver: objArgs.accessId,
      accessKeyResolver: objArgs.accessKey,
      apiUrlResolver: objArgs.apiUrl,
    };
  },
  async execute({
    id, accessIdResolver, accessKeyResolver, apiUrlResolver,
  }) {
    const accessId = await accessIdResolver.resolve();
    const accessKey = await accessKeyResolver.resolve();
    const apiUrl = await apiUrlResolver?.resolve();
    pluginInstances[id].setAuth(accessId, accessKey, apiUrl);
  },
});


plugin.registerDataType({
  name: 'akeylessAccessId',
  typeDescription: 'Akeyless Access ID for API Key authentication',
  icon: AKEYLESS_ICON,
  docs: [
    {
      description: 'Akeyless API Key Authentication',
      url: 'https://docs.akeyless.io/docs/api-key',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new plugin.ERRORS.ValidationError('Must be a string');
    }
    if (!val.startsWith('p-')) {
      throw new plugin.ERRORS.ValidationError('Akeyless Access ID should start with "p-"', {
        tip: 'API Key Access IDs start with "p-" (e.g., "p-abc123def456")',
      });
    }
    return true;
  },
});

plugin.registerDataType({
  name: 'akeylessAccessKey',
  sensitive: true,
  typeDescription: 'Akeyless Access Key for API Key authentication',
  icon: AKEYLESS_ICON,
  docs: [
    {
      description: 'Akeyless API Key Authentication',
      url: 'https://docs.akeyless.io/docs/api-key',
    },
  ],
});


plugin.registerResolverFunction({
  name: 'akeyless',
  label: 'Fetch secret from Akeyless',
  icon: AKEYLESS_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let secretNameResolver: Resolver | undefined;
    let itemKey: string | undefined;
    let secretType: 'static' | 'dynamic' | 'rotated' = 'static';

    // Check for named 'type' parameter to select secret type
    if (this.objArgs?.type) {
      if (!this.objArgs.type.isStatic) {
        throw new SchemaError('Expected type to be a static value');
      }
      const typeValue = String(this.objArgs.type.staticValue);
      if (typeValue === 'static' || typeValue === 'dynamic' || typeValue === 'rotated') {
        secretType = typeValue;
      } else {
        throw new SchemaError(`Invalid secret type "${typeValue}"`, {
          tip: 'Valid types are: static, dynamic, rotated',
        });
      }
    }

    if (!this.arrArgs || this.arrArgs.length === 0) {
      instanceId = '_default';
      // Use item key as secret name
      const parent = (this as any).parent;
      if (parent && typeof parent.key === 'string') {
        itemKey = parent.key;
      } else {
        throw new SchemaError('When called without arguments, akeyless() must be used on a config item', {
          tip: 'Either provide a secret name: akeyless("/path/to/secret") or use it on a config item',
        });
      }
    } else if (this.arrArgs.length === 1) {
      instanceId = '_default';
      secretNameResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('Expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs[0].staticValue);
      secretNameResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Akeyless plugin instances found', {
        tip: 'Initialize at least one Akeyless instance using the @initAkeyless() root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Akeyless plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initAkeyless call',
            'or use `akeyless(id, secretName)` to select an instance by id.',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Akeyless plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, secretNameResolver, itemKey, secretType,
    };
  },
  async resolve({
    instanceId, secretNameResolver, itemKey, secretType,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    // Resolve secret name
    let secretName: string;
    if (secretNameResolver) {
      const resolved = await secretNameResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected secret name to resolve to a string');
      }
      secretName = resolved;
    } else if (itemKey) {
      secretName = itemKey;
    } else {
      throw new SchemaError('No secret name provided');
    }

    if (secretType === 'dynamic') {
      return await selectedInstance.getDynamicSecret(secretName);
    }
    if (secretType === 'rotated') {
      return await selectedInstance.getRotatedSecret(secretName);
    }
    return await selectedInstance.getStaticSecret(secretName);
  },
});
