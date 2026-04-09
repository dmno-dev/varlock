import { type Resolver, type PluginCacheAccessor, plugin } from 'varlock/plugin-lib';

import { GoogleAuth } from 'google-auth-library';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const GSM_ICON = 'devicon:googlecloud';

plugin.name = 'gsm';
const { debug } = plugin;
debug('init - version =', plugin.version);
// capture cache accessor while the plugin proxy context is active
// (the `plugin` proxy is only valid during module initialization, not during resolve())
let pluginCache: PluginCacheAccessor | undefined;
try {
  pluginCache = plugin.cache;
} catch {
  // cache not available (e.g., no encryption key)
}
plugin.icon = GSM_ICON;
plugin.standardVars = {
  initDecorator: '@initGsm',
  params: {
    projectId: { key: ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'] },
    credentials: { key: 'GOOGLE_APPLICATION_CREDENTIALS' },
  },
};

class GsmPluginInstance {
  private projectId?: string;
  private credentials?: any;
  /** optional cache TTL - when set, resolved values are cached */
  cacheTtl?: string | number;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(projectId?: any, credentials?: any) {
    this.credentials = credentials;
    this.projectId = projectId ? String(projectId) : undefined;
    debug('gsm instance', this.id, 'set auth - projectId:', projectId, 'hasCredentials:', !!credentials);
  }

  private authClientPromise: Promise<GoogleAuth> | undefined;
  async initClient() {
    if (this.authClientPromise) return this.authClientPromise;

    this.authClientPromise = (async () => {
      try {
        const authConfig: ConstructorParameters<typeof GoogleAuth>[0] = {
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        };

        if (this.credentials) {
          // Parse credentials if it's a string
          let parsedCredentials = this.credentials;
          if (typeof this.credentials === 'string') {
            try {
              parsedCredentials = JSON.parse(this.credentials);
            } catch (err) {
              throw new SchemaError('Invalid service account JSON format');
            }
          }
          authConfig.credentials = parsedCredentials;

          // Extract projectId from credentials if not explicitly provided
          if (!this.projectId && parsedCredentials.project_id) {
            this.projectId = parsedCredentials.project_id;
          }
          debug('Using Service Account Credentials');
        } else {
          debug('Using Application Default Credentials');
        }

        if (this.projectId) {
          authConfig.projectId = this.projectId;
        }

        const auth = new GoogleAuth(authConfig);
        debug('GSM auth client initialized for instance', this.id);
        return auth;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new SchemaError(`Failed to initialize Google Secret Manager client: ${errorMsg}`, {
          tip: [
            'Verify service account JSON is valid',
            'For ADC: Run `gcloud auth application-default login`',
            'Check GOOGLE_APPLICATION_CREDENTIALS environment variable',
          ].join('\n'),
        });
      }
    })();

    return this.authClientPromise;
  }

  private buildSecretPath(secretRef: string): string {
    // If already a full path, use as-is
    if (secretRef.startsWith('projects/')) {
      return secretRef;
    }

    // Parse simple format: "secretName" or "secretName@version"
    const [name, version = 'latest'] = secretRef.split('@');

    if (!this.projectId) {
      throw new SchemaError('projectId required for short secret references', {
        tip: 'Either provide projectId in @initGsm() or use full secret path: projects/PROJECT_ID/secrets/SECRET_NAME/versions/VERSION',
      });
    }

    return `projects/${this.projectId}/secrets/${name}/versions/${version}`;
  }

  async readSecret(secretRef: string): Promise<string> {
    const auth = await this.initClient();

    try {
      const secretPath = this.buildSecretPath(secretRef);
      const url = `https://secretmanager.googleapis.com/v1/${secretPath}:access`;

      const client = await auth.getClient();
      const headers = await client.getRequestHeaders();
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as any;
        const status = response.status;
        const errorMsg = body?.error?.message || response.statusText;

        if (status === 404) {
          const secretName = secretRef.split('@')[0];
          throw new ResolutionError(`Secret "${secretName}" not found`, {
            tip: 'Verify secret exists in Google Cloud Console',
          });
        } else if (status === 403) {
          throw new ResolutionError(`Permission denied accessing secret "${secretRef}"`, {
            tip: 'Ensure the account has "Secret Manager Secret Accessor" role',
          });
        } else if (status === 401) {
          throw new ResolutionError('Authentication failed', {
            tip: [
              errorMsg,
              'To fix this, choose one of the following:',
              '  1. Run: `gcloud auth application-default login`',
              '  2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable to a service account JSON file path',
              '  3. Provide credentials explicitly via @initGsm(credentials=$GCP_SA_KEY)',
            ].join('\n'),
          });
        } else {
          throw new ResolutionError(`Google Secret Manager error (${status}): ${errorMsg}`);
        }
      }

      const body = await response.json() as any;
      const secretData = body?.payload?.data
        ? Buffer.from(body.payload.data, 'base64').toString('utf-8')
        : undefined;

      if (!secretData) {
        throw new ResolutionError('Secret data is empty');
      }

      return secretData;
    } catch (err) {
      // Re-throw our own errors as-is
      if (err instanceof ResolutionError || err instanceof SchemaError) {
        throw err;
      }

      const error = err as Error;
      throw new ResolutionError(`Google Secret Manager error: ${error.message}`);
    }
  }
}

const pluginInstances: Record<string, GsmPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initGsm',
  description: 'Initialize a Google Secret Manager plugin instance for gsm() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');

    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }
    pluginInstances[id] = new GsmPluginInstance(id);

    return {
      id,
      cacheTtlResolver: objArgs.cacheTtl,
      projectIdResolver: objArgs.projectId,
      credentialsResolver: objArgs.credentials,
    };
  },
  async execute({
    id, cacheTtlResolver, projectIdResolver, credentialsResolver,
  }) {
    const projectId = await projectIdResolver?.resolve();
    const credentials = await credentialsResolver?.resolve();
    pluginInstances[id].setAuth(projectId, credentials);
    // cacheTtl is resolved at runtime so it can be dynamic (e.g., cacheTtl=if(forEnv(dev), "1h"))
    const cacheTtl = await cacheTtlResolver?.resolve();
    if (cacheTtl !== undefined && cacheTtl !== false && cacheTtl !== ''
      && (typeof cacheTtl === 'string' || typeof cacheTtl === 'number')
    ) {
      pluginInstances[id].cacheTtl = cacheTtl;
    }
  },
});

plugin.registerDataType({
  name: 'gcpServiceAccountJson',
  sensitive: true,
  typeDescription: 'Google Cloud service account JSON key for authentication with Secret Manager',
  icon: GSM_ICON,
  docs: [
    {
      description: 'Creating and managing service accounts',
      url: 'https://cloud.google.com/iam/docs/service-accounts-create',
    },
    {
      description: 'Secret Manager documentation',
      url: 'https://cloud.google.com/secret-manager/docs',
    },
  ],
  async validate(val): Promise<true> {
    // Accept string (JSON) or object
    let parsed;
    if (typeof val === 'string') {
      try {
        parsed = JSON.parse(val);
      } catch {
        throw new ValidationError('Must be valid JSON');
      }
    } else if (typeof val === 'object' && val !== null) {
      parsed = val;
    } else {
      throw new ValidationError('Must be a JSON string or object');
    }

    // Validate required fields
    if (!parsed.type || parsed.type !== 'service_account') {
      throw new ValidationError('Must be a service_account credential (type field should be "service_account")');
    }
    if (!parsed.project_id) {
      throw new ValidationError('Missing required field: project_id');
    }
    if (!parsed.private_key) {
      throw new ValidationError('Missing required field: private_key');
    }
    if (!parsed.client_email) {
      throw new ValidationError('Missing required field: client_email');
    }

    return true;
  },
});

plugin.registerResolverFunction({
  name: 'gsm',
  label: 'Fetch secret from Google Secret Manager',
  icon: GSM_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId = '_default';
    let secretRefResolver: Resolver | undefined;
    let itemKey: string | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // gsm() - use item key
    } else if (argCount === 1) {
      secretRefResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      if (!(this.arrArgs![0].isStatic)) {
        throw new SchemaError('Expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretRefResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0-2 arguments');
    }

    // If no secret name provided, get it from the config item key
    if (!secretRefResolver) {
      // Access parent via type assertion since it's private but we need it for this feature
      const parent = (this as any).parent;
      if (parent && typeof parent.key === 'string') {
        itemKey = parent.key;
      } else {
        throw new SchemaError('When called without arguments, gsm() must be used on a config item', {
          tip: 'Either provide a secret reference: gsm("secretName") or use it on a config item',
        });
      }
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Google Secret Manager plugin instances found', {
        tip: 'Initialize at least one GSM plugin instance using the @initGsm root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Google Secret Manager plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initGsm call',
            'or use `gsm(id, reference)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Google Secret Manager plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, itemKey, secretRefResolver };
  },
  async resolve({ instanceId, itemKey, secretRefResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    // Resolve secret reference - either from resolver or use item key
    let secretRef: string;
    if (secretRefResolver) {
      const resolved = await secretRefResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected secret reference to resolve to a string');
      }
      secretRef = resolved;
    } else if (itemKey) {
      secretRef = itemKey;
    } else {
      throw new SchemaError('No secret reference provided');
    }

    // check cache if cacheTtl is configured and cache is available
    if (selectedInstance.cacheTtl !== undefined && pluginCache) {
      const cacheKey = `gsm:${instanceId}:${secretRef}`;
      const cached = await pluginCache.get(cacheKey);
      if (cached !== undefined) {
        debug('cache hit for %s', cacheKey);
        return cached;
      }
      const secretValue = await selectedInstance.readSecret(secretRef);
      await pluginCache.set(cacheKey, secretValue, selectedInstance.cacheTtl);
      return secretValue;
    }

    return await selectedInstance.readSecret(secretRef);
  },
});
