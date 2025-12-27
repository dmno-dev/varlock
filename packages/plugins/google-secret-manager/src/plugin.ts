import { Resolver } from 'varlock/plugin-lib';

import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const GSM_ICON = 'devicon:googlecloud';

plugin.name = 'gsm';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = GSM_ICON;

class GsmPluginInstance {
  private projectId?: string;
  private credentials?: any;
  private useADC?: boolean;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(credentials: any, projectId?: string, useADC?: boolean) {
    this.credentials = credentials;
    this.projectId = projectId;
    this.useADC = useADC;
    debug('gsm instance', this.id, 'set auth - projectId:', projectId, 'useADC:', useADC);
  }

  private clientPromise: Promise<SecretManagerServiceClient> | undefined;
  async initClient() {
    if (this.clientPromise) return this.clientPromise;

    this.clientPromise = (async () => {
      try {
        const clientConfig: any = {};

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
          clientConfig.credentials = parsedCredentials;

          // Extract projectId from credentials if not explicitly provided
          if (!this.projectId && parsedCredentials.project_id) {
            this.projectId = parsedCredentials.project_id;
          }
        } else if (this.useADC) {
          // Use Application Default Credentials (will auto-detect from environment)
          debug('Using Application Default Credentials');
        } else {
          throw new SchemaError('No credentials provided', {
            tip: 'Either provide credentials (service account JSON) or set useADC=true',
          });
        }

        if (this.projectId) {
          clientConfig.projectId = this.projectId;
        }

        const client = new SecretManagerServiceClient(clientConfig);
        debug('GSM client initialized for instance', this.id);
        return client;
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

    return this.clientPromise;
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

  readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

  async readSecret(secretRef: string): Promise<string> {
    await this.initClient();

    // Simple batching setup to parallelize reads
    let triggerBatch = false;
    if (!this.readBatch) {
      this.readBatch = {};
      triggerBatch = true;
    }

    // Add secret to batch with deferred promise
    this.readBatch[secretRef] ||= { defers: [] };
    const deferred = createDeferredPromise<string>();
    this.readBatch[secretRef].defers.push(deferred);

    if (triggerBatch) {
      setImmediate(() => this.executeReadBatch());
    }

    return deferred.promise as Promise<string>;
  }

  private async executeReadBatch() {
    const client = await this.clientPromise;
    if (!client) throw new Error('Expected GSM client to be initialized');

    const batch = this.readBatch;
    this.readBatch = undefined;

    const secretRefs = Object.keys(batch || {});
    debug('batch fetching', secretRefs);
    if (!secretRefs.length) return;

    // Build secret paths
    const secretPaths = secretRefs.map((ref) => {
      try {
        return { ref, path: this.buildSecretPath(ref) };
      } catch (err) {
        return { ref, error: err as Error };
      }
    });

    // Parallelize individual secret reads (GSM doesn't have bulk API)
    const results = await Promise.allSettled(
      secretPaths.map(async ({ ref, path, error }) => {
        if (error) throw error;
        const [response] = await client.accessSecretVersion({ name: path });
        return { ref, data: response.payload?.data?.toString() };
      }),
    );

    // Resolve/reject deferred promises based on results
    results.forEach((result, idx) => {
      const secretRef = secretRefs[idx];
      const defers = batch![secretRef].defers;

      if (result.status === 'fulfilled') {
        const secretData = result.value.data;
        if (secretData) {
          defers.forEach((d) => d.resolve(secretData));
        } else {
          defers.forEach((d) => d.reject(
            new ResolutionError('Secret data is empty'),
          ));
        }
      } else {
        const err = result.reason;
        let errorMessage = 'Failed to fetch secret';
        let errorTip: string | undefined;

        // Handle common GSM errors
        if (err?.code === 5 || err?.message?.includes('NOT_FOUND')) {
          const secretName = secretRef.split('@')[0];
          errorMessage = `Secret "${secretName}" not found`;
          errorTip = 'Verify secret exists in Google Cloud Console';
        } else if (err?.code === 7 || err?.message?.includes('PERMISSION_DENIED')) {
          errorMessage = `Permission denied accessing secret "${secretRef}"`;
          errorTip = 'Ensure service account has "Secret Manager Secret Accessor" role';
        } else if (err?.message) {
          errorMessage = `Google Secret Manager error: ${err.message}`;
        }

        const wrappedErr = new ResolutionError(errorMessage, {
          tip: errorTip,
        });
        defers.forEach((d) => d.reject(wrappedErr));
      }
    });
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

    if (objArgs.projectId && !objArgs.projectId.isStatic) {
      throw new SchemaError('Expected projectId to be static');
    }
    const projectId = objArgs?.projectId ? String(objArgs.projectId.staticValue) : undefined;

    // User should either be setting credentials, useADC, or both
    if (!objArgs.credentials && !objArgs.useADC) {
      throw new SchemaError('Either credentials or useADC must be set', {
        tip: 'Provide credentials (service account JSON) or set useADC=true for Application Default Credentials',
      });
    }

    return {
      id,
      projectId,
      credentialsResolver: objArgs.credentials,
      useADCResolver: objArgs.useADC,
    };
  },
  async execute({
    id, projectId, credentialsResolver, useADCResolver,
  }) {
    const credentials = await credentialsResolver?.resolve();
    const enableADC = await useADCResolver?.resolve();
    pluginInstances[id].setAuth(credentials, projectId, !!enableADC);
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
    arrayMinLength: 1,
  },
  process() {
    if (!this.arrArgs || !this.arrArgs.length) {
      throw new SchemaError('Expected 1 or 2 arguments');
    }

    let instanceId: string;
    let secretRefResolver: Resolver;
    if (this.arrArgs.length === 1) {
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
      throw new SchemaError('Expected 1 or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Google Secret Manager plugin instances found', {
        tip: 'Initialize at least one GSM plugin instance using the @initGsm root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Google Secret Manager plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initGsm call',
            'or use `gsm(id, reference)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Google Secret Manager plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, secretRefResolver };
  },
  async resolve({ instanceId, secretRefResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const secretRef = await secretRefResolver.resolve();
    if (typeof secretRef !== 'string') {
      throw new SchemaError('Expected secret reference to resolve to a string');
    }
    const secretValue = await selectedInstance.readSecret(secretRef);
    return secretValue;
  },
});
