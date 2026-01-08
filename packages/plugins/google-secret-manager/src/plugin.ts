import { Resolver } from 'varlock/plugin-lib';

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

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(projectId?: any, credentials?: any) {
    this.credentials = credentials;
    this.projectId = projectId ? String(projectId) : undefined;
    debug('gsm instance', this.id, 'set auth - projectId:', projectId, 'hasCredentials:', !!credentials);
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
          debug('Using Service Account Credentials');
        } else {
          // Use Application Default Credentials (will auto-detect from environment)
          // Default to ADC when no credentials are provided
          debug('Using Application Default Credentials');
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

  async readSecret(secretRef: string): Promise<string> {
    const client = await this.initClient();
    if (!client) throw new Error('Expected GSM client to be initialized');

    try {
      const secretPath = this.buildSecretPath(secretRef);
      const [response] = await client.accessSecretVersion({ name: secretPath });
      const secretData = response.payload?.data?.toString();

      if (!secretData) {
        throw new ResolutionError('Secret data is empty');
      }

      return secretData;
    } catch (err) {
      // Re-throw ResolutionError as-is
      if (err instanceof ResolutionError) {
        throw err;
      }

      let errorMessage = 'Failed to fetch secret';
      let errorTip: string | undefined;

      // Handle common GSM errors
      const error = err as Error & { code?: number };
      if (error.code === 5 || error.message?.includes('NOT_FOUND')) {
        const secretName = secretRef.split('@')[0];
        errorMessage = `Secret "${secretName}" not found`;
        errorTip = 'Verify secret exists in Google Cloud Console';
      } else if (error.code === 7 || error.message?.includes('PERMISSION_DENIED')) {
        errorMessage = `Permission denied accessing secret "${secretRef}"`;
        errorTip = 'Ensure service account has "Secret Manager Secret Accessor" role';
      } else if (
        error.code === 16
        || error.message.includes('credentials')
      ) {
        // Check if we're using ADC (no explicit credentials provided)
        if (!this.credentials) {
          errorMessage = 'Authentication failed';
          errorTip = [
            error.message,
            'To fix this, choose one of the following:',
            '  1. Run: `gcloud auth application-default login`',
            '  2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable to a service account JSON file path',
            '  3. Provide credentials explicitly via @initGsm(credentials=$GCP_SA_KEY)',
          ].join('\n');
        } else {
          errorMessage = 'Authentication failed with provided credentials';
          errorTip = 'Verify that the service account JSON is valid and has the required permissions';
        }
      } else if (error.message) {
        errorMessage = `Google Secret Manager error: ${error.message}`;
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
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
      projectIdResolver: objArgs.projectId,
      credentialsResolver: objArgs.credentials,
    };
  },
  async execute({
    id, projectIdResolver, credentialsResolver,
  }) {
    const projectId = await projectIdResolver?.resolve();
    const credentials = await credentialsResolver?.resolve();
    pluginInstances[id].setAuth(projectId, credentials);
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
