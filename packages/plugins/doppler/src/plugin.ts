import {
  type Resolver, type PluginCacheAccessor, plugin, resolveCacheTtl,
} from 'varlock/plugin-lib';
import { createHash } from 'node:crypto';
import ky from 'ky';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const DOPPLER_ICON = 'simple-icons:doppler';
const DOPPLER_API_BASE = 'https://api.doppler.com/v3';

plugin.name = 'doppler';
const { debug } = plugin;
debug('init - version =', plugin.version);
// capture cache accessor while plugin proxy context is active
let pluginCache: PluginCacheAccessor | undefined;
try {
  pluginCache = plugin.cache;
} catch {
  // cache unavailable in this runtime context
}
plugin.icon = DOPPLER_ICON;
plugin.standardVars = {
  initDecorator: '@initDoppler',
  params: {
    serviceToken: { key: 'DOPPLER_TOKEN', dataType: 'dopplerServiceToken' },
  },
};

class DopplerPluginInstance {
  /** Doppler project name */
  private project?: string;
  /** Doppler config name (e.g., dev, stg, prd) */
  private config?: string;
  /** Service token for API access */
  private serviceToken?: string;
  /** optional cache TTL - when set, resolved values are cached */
  cacheTtl?: string | number;
  /** Cache for fetched secrets (keyed by project+config) */
  private secretsCache?: Promise<Record<string, string>>;

  constructor(
    readonly id: string,
  ) {}

  setAuth(
    project: any,
    config: any,
    serviceToken: any,
  ) {
    if (project && typeof project === 'string') this.project = project;
    if (config && typeof config === 'string') this.config = config;
    if (serviceToken && typeof serviceToken === 'string') this.serviceToken = serviceToken;
    debug('doppler instance', this.id, 'set auth - project:', project, 'config:', config);
  }

  private _cacheKeyIdentity?: string;
  /** short hash identifying which Doppler workplace/token is being read, used to namespace cache keys */
  get cacheKeyIdentity() {
    // the service token identifies the workplace/account (it is hashed, never stored raw)
    this._cacheKeyIdentity ??= createHash('sha256')
      .update(JSON.stringify([this.serviceToken]))
      .digest('hex')
      .slice(0, 12);
    return this._cacheKeyIdentity;
  }

  getCacheScope(): string {
    return `${this.cacheKeyIdentity}:${this.project || ''}:${this.config || ''}`;
  }

  private getAuthHeaders(): Record<string, string> {
    if (!this.serviceToken) {
      throw new SchemaError('Doppler service token is required', {
        tip: 'Set serviceToken in @initDoppler() decorator',
      });
    }

    // Service tokens use Bearer auth
    return {
      Authorization: `Bearer ${this.serviceToken}`,
    };
  }

  /**
   * Fetch all secrets for the configured project/config.
   * Results are cached so multiple secret lookups share a single API call.
   */
  private fetchAllSecrets(): Promise<Record<string, string>> {
    if (this.secretsCache) return this.secretsCache;

    this.secretsCache = this._fetchAllSecrets();
    // Clear cache on failure so retries can try again
    this.secretsCache.catch(() => {
      this.secretsCache = undefined;
    });
    return this.secretsCache;
  }

  private async _fetchAllSecrets(): Promise<Record<string, string>> {
    if (!this.project || !this.config) {
      throw new ResolutionError('Project and config must be configured');
    }

    const headers = this.getAuthHeaders();

    try {
      debug(`Fetching all secrets for project="${this.project}" config="${this.config}"`);

      const response = await ky.get(`${DOPPLER_API_BASE}/configs/config/secrets`, {
        headers,
        searchParams: {
          project: this.project,
          config: this.config,
        },
      }).json<{ secrets: Record<string, { raw: string; computed: string }> }>();

      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.secrets)) {
        result[key] = value.computed ?? value.raw;
      }
      debug(`Fetched ${Object.keys(result).length} secrets`);
      return result;
    } catch (err: any) {
      return this.handleDopplerError(err, 'list secrets');
    }
  }

  async getSecret(secretName: string): Promise<string> {
    if (!this.project || !this.config) {
      throw new ResolutionError('Project and config must be configured');
    }

    // Use bulk fetch + cache for efficiency — Doppler's API is optimized for this
    const secrets = await this.fetchAllSecrets();

    if (!(secretName in secrets)) {
      throw new ResolutionError(
        `Secret "${secretName}" not found in project "${this.project}" config "${this.config}"`,
        {
          tip: [
            'Check the secret exists in the Doppler dashboard:',
            `  https://dashboard.doppler.com/workplace/projects/${this.project}/configs/${this.config}`,
            'Verify the secret name matches exactly (case-sensitive)',
          ].join('\n'),
        },
      );
    }

    return secrets[secretName];
  }

  async listSecrets(): Promise<string> {
    const secrets = await this.fetchAllSecrets();
    return JSON.stringify(secrets);
  }

  private handleDopplerError(err: any, operation: string): never {
    const errorMsg = err?.message || String(err);
    const statusCode = err?.response?.status;

    const location = `project "${this.project}" config "${this.config}"`;

    if (statusCode === 401) {
      throw new ResolutionError(`Authentication failed for ${location}`, {
        tip: [
          'Verify your Doppler service token is correct and not expired',
          'Generate a new service token in the Doppler dashboard:',
          `  https://dashboard.doppler.com/workplace/projects/${this.project}/configs/${this.config}/access`,
        ].join('\n'),
      });
    }

    if (statusCode === 403) {
      throw new ResolutionError(`Access denied for ${location}`, {
        tip: [
          'Verify your service token has access to this project and config',
          'Service tokens are scoped to a specific config — ensure you are using the correct one',
        ].join('\n'),
      });
    }

    if (statusCode === 404) {
      throw new ResolutionError(`Project or config not found: ${location}`, {
        tip: [
          'Verify the project and config names are correct',
          'Check the Doppler dashboard: https://dashboard.doppler.com',
        ].join('\n'),
      });
    }

    throw new ResolutionError(`Failed to ${operation} in ${location}: ${errorMsg}`, {
      tip: 'Check your network connection and Doppler service status at https://status.doppler.com',
    });
  }
}

const pluginInstances: Record<string, DopplerPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initDoppler',
  description: 'Initialize a Doppler plugin instance for doppler() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected configuration arguments');

    // Validate id (must be static if provided)
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');

    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    // Validate required fields
    if (!objArgs.project) {
      throw new SchemaError('project is required', {
        tip: 'Add project parameter: @initDoppler(project=my-project, ...)',
      });
    }

    if (!objArgs.config) {
      throw new SchemaError('config is required', {
        tip: 'Add config parameter: @initDoppler(config=dev, ...)',
      });
    }

    if (!objArgs.serviceToken) {
      throw new SchemaError('serviceToken is required', {
        tip: 'Add serviceToken parameter: @initDoppler(serviceToken=$DOPPLER_TOKEN, ...)',
      });
    }

    // Create instance
    pluginInstances[id] = new DopplerPluginInstance(id);

    return {
      id,
      cacheTtlResolver: objArgs.cacheTtl,
      projectResolver: objArgs.project,
      configResolver: objArgs.config,
      serviceTokenResolver: objArgs.serviceToken,
    };
  },
  async execute({
    id,
    cacheTtlResolver,
    projectResolver,
    configResolver,
    serviceTokenResolver,
  }) {
    // Even if these are empty, we can't throw errors yet
    // in case the instance is never actually used
    const project = await projectResolver?.resolve();
    const config = await configResolver?.resolve();
    const serviceToken = await serviceTokenResolver?.resolve();

    pluginInstances[id].setAuth(project, config, serviceToken);
    const cacheTtl = await resolveCacheTtl(cacheTtlResolver);
    if (cacheTtl !== undefined) {
      pluginInstances[id].cacheTtl = cacheTtl;
    }
  },
});

plugin.registerDataType({
  name: 'dopplerServiceToken',
  sensitive: true,
  internal: true,
  typeDescription: 'Doppler service token for API access',
  icon: DOPPLER_ICON,
  docs: [
    {
      description: 'Doppler Service Tokens',
      url: 'https://docs.doppler.com/docs/service-tokens',
    },
  ],
});

plugin.registerResolverFunction({
  name: 'doppler',
  label: 'Fetch secret value from Doppler',
  icon: DOPPLER_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId = '_default';
    let secretNameResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // doppler() - use item key as secret name
    } else if (argCount === 1) {
      // doppler("SECRET_NAME")
      secretNameResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // doppler(instanceId, "SECRET_NAME")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretNameResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0-2 arguments');
    }

    // If no secret name provided, get it from the config item key
    let itemKey: string | undefined;
    if (!secretNameResolver) {
      const parent = (this as any).parent;
      if (parent && typeof parent.key === 'string') {
        itemKey = parent.key;
      } else {
        throw new SchemaError('When called without arguments, doppler() must be used on a config item', {
          tip: 'Either provide a secret name: doppler("SECRET_NAME") or use it on a config item',
        });
      }
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Doppler plugin instances found', {
        tip: 'Initialize at least one Doppler plugin instance using @initDoppler() decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Doppler plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initDoppler call',
            'or use `doppler(id, secretName)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Doppler plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, itemKey, secretNameResolver,
    };
  },
  async resolve({
    instanceId, itemKey, secretNameResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    // Resolve secret name - either from resolver or use item key
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

    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      const cacheKey = `doppler:${instanceId}:${selectedInstance.getCacheScope()}:bulk`;
      const secrets = await pluginCache.getOrSet(
        cacheKey,
        selectedInstance.cacheTtl,
        async () => JSON.parse(await selectedInstance.listSecrets()) as Record<string, string>,
      );
      if (!secrets || typeof secrets !== 'object') {
        throw new ResolutionError('Cached Doppler bulk payload has unexpected type (expected object)');
      }

      if (!(secretName in secrets)) {
        throw new ResolutionError(
          `Secret "${secretName}" not found in configured Doppler project/config`,
        );
      }

      return secrets[secretName];
    }

    const secretValue = await selectedInstance.getSecret(secretName);
    return secretValue;
  },
});

plugin.registerResolverFunction({
  name: 'dopplerBulk',
  label: 'Load all secrets from a Doppler config',
  icon: DOPPLER_ICON,
  argsSchema: {
    type: 'array',
    arrayMaxLength: 1,
  },
  process() {
    // Optional positional arg = instance id
    let instanceId = '_default';
    if (this.arrArgs?.length) {
      if (!this.arrArgs[0].isStatic) {
        throw new SchemaError('Expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs[0].staticValue);
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Doppler plugin instances found', {
        tip: 'Initialize at least one Doppler plugin instance using @initDoppler() decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Doppler plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initDoppler call',
            'or use `dopplerBulk(id)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Doppler plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId };
  },
  async resolve({ instanceId }) {
    const selectedInstance = pluginInstances[instanceId];
    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      const cacheKey = `doppler:${instanceId}:${selectedInstance.getCacheScope()}:bulk`;
      const cachedOrFetched = await pluginCache.getOrSet(
        cacheKey,
        selectedInstance.cacheTtl,
        async () => JSON.parse(await selectedInstance.listSecrets()),
      );
      if (cachedOrFetched !== undefined && typeof cachedOrFetched === 'object' && cachedOrFetched !== null) {
        return JSON.stringify(cachedOrFetched);
      }
      throw new ResolutionError('Cached Doppler bulk payload has unexpected type (expected object)');
    }
    return await selectedInstance.listSecrets();
  },
});

// Anonymous, non-sensitive usage signals. Strictly sanitized before send.
plugin.registerTelemetryAttributes(() => {
  const instances = Object.values(pluginInstances);
  return {
    // standard attributes
    instance_count: instances.length,
    cache_enabled: instances.some((i) => i.cacheTtl != null),
  };
});
