import { Resolver } from 'varlock/plugin-lib';
import { InfisicalSDK } from '@infisical/sdk';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const INFISICAL_ICON = 'simple-icons:infisical';

plugin.name = 'infisical';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = INFISICAL_ICON;

class InfisicalPluginInstance {
  /** Infisical project ID */
  private projectId?: string;
  /** Environment (dev, staging, production, etc.) */
  private environment?: string;
  /** Optional custom Infisical instance URL */
  private siteUrl?: string;
  /** Client ID for Universal Auth */
  private clientId?: string;
  /** Client Secret for Universal Auth */
  private clientSecret?: string;
  /** Optional default secret path */
  private secretPath?: string;

  constructor(
    readonly id: string,
  ) {}

  setAuth(
    projectId: string,
    environment: string,
    clientId: string,
    clientSecret: string,
    siteUrl?: string,
    secretPath?: string,
  ) {
    this.projectId = projectId;
    this.environment = environment;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.siteUrl = siteUrl;
    this.secretPath = secretPath;
    debug('infisical instance', this.id, 'set auth - projectId:', projectId, 'environment:', environment);
  }

  private infisicalClientPromise?: Promise<InfisicalSDK>;

  private async initClient() {
    if (this.infisicalClientPromise) return this.infisicalClientPromise;

    if (!this.clientId || !this.clientSecret) {
      throw new SchemaError('Infisical client ID and secret are required', {
        tip: 'Set clientId and clientSecret in @initInfisical() decorator',
      });
    }

    this.infisicalClientPromise = (async () => {
      try {
        const clientConfig: any = {};
        if (this.siteUrl) {
          clientConfig.siteUrl = this.siteUrl;
        }

        const client = new InfisicalSDK(clientConfig);

        // Authenticate using Universal Auth
        await client.auth().universalAuth.login({
          clientId: this.clientId!,
          clientSecret: this.clientSecret!,
        });

        debug('Infisical client initialized successfully');
        return client;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        throw new SchemaError(`Failed to initialize Infisical client: ${errorMsg}`, {
          tip: [
            'Verify client ID and secret are correct',
            'Check if your machine identity has access to the project',
            'If using self-hosted Infisical, verify siteUrl is correct',
          ].join('\n'),
        });
      }
    })();

    return this.infisicalClientPromise;
  }

  async getSecret(secretName: string, secretPath?: string): Promise<string> {
    if (!this.projectId || !this.environment) {
      throw new ResolutionError('Project ID and environment must be configured');
    }

    const client = await this.initClient();

    try {
      const result = await client.secrets().getSecret({
        secretName,
        projectId: this.projectId,
        environment: this.environment,
        secretPath: secretPath || this.secretPath || '/',
        expandSecretReferences: true,
        viewSecretValue: true,
        includeImports: true,
      });

      if (!result?.secretValue) {
        throw new ResolutionError(`Secret "${secretName}" has no value`);
      }

      return result.secretValue;
    } catch (err: any) {
      return this.handleInfisicalError(err, secretName, secretPath);
    }
  }

  private handleInfisicalError(err: any, secretName: string, secretPath?: string): never {
    const errorMsg = err?.message || String(err);
    const statusCode = err?.statusCode || err?.response?.status;

    const pathInfo = secretPath || this.secretPath ? ` at path "${secretPath || this.secretPath}"` : '';
    const location = `"${secretName}"${pathInfo} in project "${this.projectId}" environment "${this.environment}"`;

    if (statusCode === 404 || errorMsg.includes('not found') || errorMsg.includes('NotFound')) {
      throw new ResolutionError(`Secret ${location} not found`, {
        tip: [
          'Check the secret exists in Infisical console:',
          this.siteUrl ? `${this.siteUrl}/project/${this.projectId}` : `https://app.infisical.com/project/${this.projectId}`,
          'Verify the secret name, path, and environment are correct',
        ].join('\n'),
      });
    }

    if (statusCode === 403 || statusCode === 401 || errorMsg.includes('Unauthorized') || errorMsg.includes('Forbidden')) {
      throw new ResolutionError(`Access denied for secret ${location}`, {
        tip: [
          'Verify your machine identity has the correct permissions',
          'Check that the machine identity has access to this project and environment',
          'Review the role assignments in Infisical console',
        ].join('\n'),
      });
    }

    if (errorMsg.includes('auth') || errorMsg.includes('credential')) {
      throw new ResolutionError(`Authentication failed: ${errorMsg}`, {
        tip: [
          'Verify clientId and clientSecret are correct',
          'Check if the machine identity credentials have expired',
          'Ensure the machine identity is not disabled',
        ].join('\n'),
      });
    }

    // Generic error
    throw new ResolutionError(`Failed to fetch secret ${location}: ${errorMsg}`, {
      tip: 'Check Infisical service status and your network connection',
    });
  }
}

const pluginInstances: Record<string, InfisicalPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initInfisical',
  description: 'Initialize an Infisical plugin instance for infisical() resolver',
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
    if (!objArgs.projectId) {
      throw new SchemaError('projectId is required', {
        tip: 'Add projectId parameter: @initInfisical(projectId=your-project-id, ...)',
      });
    }

    if (!objArgs.environment) {
      throw new SchemaError('environment is required', {
        tip: 'Add environment parameter: @initInfisical(environment=dev, ...)',
      });
    }

    if (!objArgs.clientId) {
      throw new SchemaError('clientId is required', {
        tip: 'Add clientId parameter: @initInfisical(clientId=$INFISICAL_CLIENT_ID, ...)',
      });
    }

    if (!objArgs.clientSecret) {
      throw new SchemaError('clientSecret is required', {
        tip: 'Add clientSecret parameter: @initInfisical(clientSecret=$INFISICAL_CLIENT_SECRET, ...)',
      });
    }

    // Validate siteUrl is static if provided
    if (objArgs.siteUrl && !objArgs.siteUrl.isStatic) {
      throw new SchemaError('Expected siteUrl to be static');
    }
    const siteUrl = objArgs.siteUrl ? String(objArgs.siteUrl.staticValue) : undefined;

    // Validate secretPath is static if provided
    if (objArgs.secretPath && !objArgs.secretPath.isStatic) {
      throw new SchemaError('Expected secretPath to be static');
    }
    const secretPath = objArgs.secretPath ? String(objArgs.secretPath.staticValue) : undefined;

    // Create instance
    pluginInstances[id] = new InfisicalPluginInstance(id);

    return {
      id,
      siteUrl,
      secretPath,
      projectIdResolver: objArgs.projectId,
      environmentResolver: objArgs.environment,
      clientIdResolver: objArgs.clientId,
      clientSecretResolver: objArgs.clientSecret,
    };
  },
  async execute({
    id,
    siteUrl,
    secretPath,
    projectIdResolver,
    environmentResolver,
    clientIdResolver,
    clientSecretResolver,
  }) {
    const projectId = await projectIdResolver?.resolve();
    const environment = await environmentResolver?.resolve();
    const clientId = await clientIdResolver?.resolve();
    const clientSecret = await clientSecretResolver?.resolve();

    if (!projectId || typeof projectId !== 'string') {
      throw new SchemaError('projectId must resolve to a string');
    }
    if (!environment || typeof environment !== 'string') {
      throw new SchemaError('environment must resolve to a string');
    }
    if (!clientId || typeof clientId !== 'string') {
      throw new SchemaError('clientId must resolve to a string');
    }
    if (!clientSecret || typeof clientSecret !== 'string') {
      throw new SchemaError('clientSecret must resolve to a string');
    }

    pluginInstances[id].setAuth(
      projectId,
      environment,
      clientId,
      clientSecret,
      siteUrl,
      secretPath,
    );
  },
});

plugin.registerDataType({
  name: 'infisicalClientId',
  sensitive: false, // Client ID is not typically sensitive
  typeDescription: 'Client ID for Infisical Universal Auth (machine identity)',
  icon: INFISICAL_ICON,
  docs: [
    {
      description: 'Infisical Machine Identities',
      url: 'https://infisical.com/docs/documentation/platform/identities/machine-identities',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new ValidationError('Client ID must be a non-empty string');
    }
  },
});

plugin.registerDataType({
  name: 'infisicalClientSecret',
  sensitive: true,
  typeDescription: 'Client Secret for Infisical Universal Auth (machine identity)',
  icon: INFISICAL_ICON,
  docs: [
    {
      description: 'Infisical Universal Auth',
      url: 'https://infisical.com/docs/documentation/platform/identities/universal-auth',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new ValidationError('Client Secret must be a non-empty string');
    }
  },
});

plugin.registerResolverFunction({
  name: 'infisical',
  label: 'Fetch secret value from Infisical',
  icon: INFISICAL_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId: string;
    let secretNameResolver: Resolver | undefined;
    let secretPathResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    // Parse arguments based on count
    if (argCount === 0) {
      // infisical() - use item key as secret name
      instanceId = '_default';
      // secretNameResolver will remain undefined, signaling to use item key
    } else if (argCount === 1) {
      // infisical("secretName") OR infisical(instanceId) if parent is ConfigItem
      instanceId = '_default';
      secretNameResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // Could be: infisical(instanceId, "secretName") OR infisical("secretName", "path")
      // Check if first arg is static (would be instance ID)
      if (this.arrArgs![0].isStatic) {
        instanceId = String(this.arrArgs![0].staticValue);
        secretNameResolver = this.arrArgs![1];
      } else {
        // Assume first is secret name, second is path
        instanceId = '_default';
        secretNameResolver = this.arrArgs![0];
        secretPathResolver = this.arrArgs![1];
      }
    } else if (argCount === 3) {
      // infisical(instanceId, "secretName", "path")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretNameResolver = this.arrArgs![1];
      secretPathResolver = this.arrArgs![2];
    } else {
      throw new SchemaError('Expected 0-3 arguments');
    }

    // If no secret name provided, get it from the config item key
    let itemKey: string | undefined;
    if (!secretNameResolver) {
      // Access parent via type assertion since it's private but we need it for this feature
      const parent = (this as any).parent;
      if (parent && typeof parent.key === 'string') {
        itemKey = parent.key;
      } else {
        throw new SchemaError('When called without arguments, infisical() must be used on a config item', {
          tip: 'Either provide a secret name: infisical("secretName") or use it on a config item',
        });
      }
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Infisical plugin instances found', {
        tip: 'Initialize at least one Infisical plugin instance using @initInfisical() decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Infisical plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initInfisical call',
            'or use `infisical(id, secretName)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Infisical plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, itemKey, secretNameResolver, secretPathResolver,
    };
  },
  async resolve({
    instanceId, itemKey, secretNameResolver, secretPathResolver,
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

    let secretPath: string | undefined;
    if (secretPathResolver) {
      const resolvedPath = await secretPathResolver.resolve();
      if (typeof resolvedPath !== 'string') {
        throw new SchemaError('Expected secret path to resolve to a string');
      }
      secretPath = resolvedPath;
    }

    const secretValue = await selectedInstance.getSecret(secretName, secretPath);
    return secretValue;
  },
});
