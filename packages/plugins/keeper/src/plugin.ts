import { type Resolver, plugin } from 'varlock/plugin-lib';
import {
  getSecrets,
  getValue,
  inMemoryStorage,
  type KeeperSecrets,
  type SecretManagerOptions,
} from '@keeper-security/secrets-manager-core';

const { SchemaError, ResolutionError, ValidationError } = plugin.ERRORS;

const KEEPER_ICON = 'simple-icons:keepersecurity';

// ════ PLUGIN CONFIGURATION ═══════════════════════════════════════════════════

plugin.name = 'keeper';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KEEPER_ICON;
plugin.standardVars = {
  initDecorator: '@initKeeper',
  params: {
    token: { key: 'KSM_CONFIG', dataType: 'keeperSmToken' },
  },
};

// ════ PLUGIN INSTANCE CLASS ═══════════════════════════════════════════════════

class KeeperPluginInstance {
  private configToken?: string;

  constructor(
    readonly id: string,
  ) {}

  setAuth(token: any) {
    if (token && typeof token === 'string') this.configToken = token;
    debug('keeper instance', this.id, 'set auth - hasToken:', !!this.configToken);
  }

  private sdkOptionsPromise: Promise<SecretManagerOptions> | undefined;
  private initSdkOptions(): Promise<SecretManagerOptions> {
    this.sdkOptionsPromise ||= (async () => {
      if (!this.configToken) {
        throw new ResolutionError('Keeper Secrets Manager config token is not set', {
          tip: 'Provide a base64-encoded config via @initKeeper(token=$KSM_CONFIG)',
        });
      }

      let configData: Record<string, any>;
      try {
        const decoded = Buffer.from(this.configToken, 'base64').toString('utf-8');
        configData = JSON.parse(decoded);
      } catch {
        throw new ResolutionError('Failed to parse Keeper config token', {
          tip: [
            'The token must be a valid base64-encoded JSON configuration.',
            'Generate one using the Keeper Secrets Manager CLI:',
            '  ksm profile init <one-time-token>',
            '  ksm profile export --format json | base64',
          ].join('\n'),
        });
      }

      const storage = inMemoryStorage(configData);
      return { storage };
    })();
    return this.sdkOptionsPromise;
  }

  private secretsCache: Promise<KeeperSecrets> | undefined;
  private fetchSecrets(recordsFilter?: Array<string>): Promise<KeeperSecrets> {
    // Cache secrets globally (no filter) to avoid redundant fetches
    if (!recordsFilter) {
      if (!this.secretsCache) {
        this.secretsCache = this._fetchSecrets();
        // Clear cache on failure so retries can try again
        this.secretsCache.catch(() => {
          this.secretsCache = undefined;
        });
      }
      return this.secretsCache;
    }
    return this._fetchSecrets(recordsFilter);
  }

  private async _fetchSecrets(recordsFilter?: Array<string>): Promise<KeeperSecrets> {
    const options = await this.initSdkOptions();
    try {
      debug('Fetching secrets', recordsFilter ? `(filter: ${recordsFilter.join(', ')})` : '(all)');
      return await getSecrets(options, recordsFilter);
    } catch (err: any) {
      const message = err?.message || String(err);

      if (message.includes('access denied') || message.includes('Access denied')) {
        throw new ResolutionError('Keeper access denied', {
          tip: [
            'Verify your Secrets Manager config token is valid and not expired.',
            'The application may have been revoked or the shared folder permissions may have changed.',
          ].join('\n'),
        });
      }

      if (message.includes('hostname') || message.includes('Client Id')) {
        throw new ResolutionError(`Keeper config error: ${message}`, {
          tip: [
            'Your config token may be incomplete or corrupted.',
            'Regenerate it using the Keeper Secrets Manager CLI:',
            '  ksm profile init <one-time-token>',
          ].join('\n'),
        });
      }

      throw new ResolutionError(`Keeper error: ${message}`);
    }
  }

  async getSecretByNotation(notation: string): Promise<string> {
    const secrets = await this.fetchSecrets();

    try {
      const value = getValue(secrets, notation);

      if (value === undefined || value === null) {
        throw new ResolutionError(`Keeper notation "${notation}" resolved to empty value`);
      }

      // getValue may return a string, array element, or object - coerce to string
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value[0] ?? '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    } catch (err: any) {
      if (err instanceof ResolutionError) throw err;
      const message = err?.message || String(err);
      throw new ResolutionError(`Keeper notation error: ${message}`, {
        tip: [
          'Notation format: <uid_or_title>/field/<type> or <uid_or_title>/custom_field/<label>',
          'Examples:',
          '  keeper("XXXX/field/password")   - standard field by type',
          '  keeper("XXXX/field/login")       - login field',
          '  keeper("XXXX/custom_field/API_KEY") - custom field by label',
          '  keeper("My Record/field/password")  - by record title',
        ].join('\n'),
      });
    }
  }

  async getSecretField(recordRef: string, fieldType?: string): Promise<string> {
    const secrets = await this.fetchSecrets();

    // Find the record by UID or title
    const record = secrets.records.find(
      (r) => r.recordUid === recordRef || r.data?.title === recordRef,
    );

    if (!record) {
      throw new ResolutionError(`Record "${recordRef}" not found`, {
        tip: [
          'Verify the record UID or title is correct.',
          `Available records: ${secrets.records.map((r) => `${r.recordUid} (${r.data?.title || 'untitled'})`).join(', ') || 'none'}`,
        ].join('\n'),
      });
    }

    const targetType = fieldType || 'password';

    // Search standard fields
    const fields = record.data?.fields || [];
    const field = fields.find(
      (f: any) => f.type === targetType || f.label === targetType,
    );
    if (field?.value?.[0] !== undefined) {
      return String(field.value[0]);
    }

    // Search custom fields
    const customFields = record.data?.custom || [];
    const customField = customFields.find(
      (f: any) => f.type === targetType || f.label === targetType,
    );
    if (customField?.value?.[0] !== undefined) {
      return String(customField.value[0]);
    }

    const availableFields = [
      ...fields.map((f: any) => f.type || f.label),
      ...customFields.map((f: any) => `custom:${f.label || f.type}`),
    ].filter(Boolean);

    throw new ResolutionError(`Field "${targetType}" not found in record "${recordRef}"`, {
      tip: `Available fields: ${availableFields.join(', ') || 'none'}`,
    });
  }
}

const pluginInstances: Record<string, KeeperPluginInstance> = {};

function getPluginInstance(instanceId: string, resolverName: string): KeeperPluginInstance {
  const selectedInstance = pluginInstances[instanceId];
  if (!selectedInstance) {
    if (!Object.keys(pluginInstances).length) {
      throw new SchemaError('No Keeper plugin instances found', {
        tip: 'Initialize at least one Keeper instance using the @initKeeper() root decorator',
      });
    }
    if (instanceId === '_default') {
      throw new SchemaError('Keeper plugin instance (without id) not found', {
        tip: [
          'Either remove the `id` param from your @initKeeper call',
          `or use \`${resolverName}(id, ...)\` to select an instance by id.`,
          `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
        ].join('\n'),
      });
    }
    throw new SchemaError(`Keeper plugin instance id "${instanceId}" not found`, {
      tip: `Valid ids are: ${Object.keys(pluginInstances).join(', ')}`,
    });
  }
  return selectedInstance;
}

// ════ ROOT DECORATOR: @initKeeper ════════════════════════════════════════════

plugin.registerRootDecorator({
  name: 'initKeeper',
  description: 'Initialize a Keeper Secrets Manager plugin instance',
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

    // token is required
    if (!objArgs.token) {
      throw new SchemaError('token parameter is required', {
        tip: [
          'Provide your Keeper Secrets Manager config token:',
          '  @initKeeper(token=$KSM_CONFIG)',
          '',
          'Generate one using the KSM CLI:',
          '  ksm profile init <one-time-token>',
          '  ksm profile export --format json | base64',
        ].join('\n'),
      });
    }

    pluginInstances[id] = new KeeperPluginInstance(id);

    return {
      id,
      tokenResolver: objArgs.token,
    };
  },
  async execute({ id, tokenResolver }) {
    const token = await tokenResolver?.resolve();
    pluginInstances[id].setAuth(token);
  },
});

// ════ DATA TYPE: keeperSmToken ═══════════════════════════════════════════════

plugin.registerDataType({
  name: 'keeperSmToken',
  sensitive: true,
  typeDescription: 'Base64-encoded configuration token for the [Keeper Secrets Manager](https://docs.keeper.io/secrets-manager/) SDK',
  icon: KEEPER_ICON,
  docs: [
    {
      description: 'Keeper Secrets Manager',
      url: 'https://docs.keeper.io/secrets-manager/',
    },
    {
      description: 'JavaScript SDK',
      url: 'https://docs.keeper.io/secrets-manager/secrets-manager/developer-sdk-library/javascript-sdk',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string' || !val.trim()) {
      throw new ValidationError('Keeper Secrets Manager config token must be a non-empty string');
    }
    try {
      const decoded = Buffer.from(val, 'base64').toString('utf-8');
      JSON.parse(decoded);
    } catch {
      throw new ValidationError('Keeper Secrets Manager config token must be a valid base64-encoded JSON string', {
        tip: [
          'Generate one using the KSM CLI:',
          '  ksm profile init <one-time-token>',
          '  ksm profile export --format json | base64',
        ].join('\n'),
      });
    }
  },
});

// ════ RESOLVER FUNCTION: keeper() ═══════════════════════════════════════════

plugin.registerResolverFunction({
  name: 'keeper',
  label: 'Fetch a secret field from Keeper Secrets Manager',
  icon: KEEPER_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let secretRefResolver: Resolver | undefined;
    let fieldResolver: Resolver | undefined;

    // Check for named 'field' parameter
    if (this.objArgs?.field) {
      fieldResolver = this.objArgs.field;
    }

    if (this.arrArgs!.length === 1) {
      secretRefResolver = this.arrArgs![0];
    } else if (this.arrArgs!.length === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      secretRefResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    getPluginInstance(instanceId, 'keeper');

    return { instanceId, secretRefResolver, fieldResolver };
  },
  async resolve({ instanceId, secretRefResolver, fieldResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    const secretRef = await secretRefResolver.resolve();
    if (typeof secretRef !== 'string') {
      throw new SchemaError('Expected secret reference to resolve to a string');
    }

    // Resolve optional field parameter
    let field: string | undefined;
    if (fieldResolver) {
      const fieldVal = await fieldResolver.resolve();
      if (typeof fieldVal !== 'string') {
        throw new SchemaError('Expected field parameter to resolve to a string');
      }
      field = fieldVal;
    }

    // Parse #field syntax: "uid#fieldType" or "uid#custom:label"
    let recordRef = secretRef;
    let explicitField: string | undefined;
    const hashIndex = secretRef.indexOf('#');
    if (hashIndex !== -1) {
      recordRef = secretRef.substring(0, hashIndex);
      explicitField = secretRef.substring(hashIndex + 1);
    }

    // If the ref contains a slash, treat as notation (uid/field/type format)
    if (recordRef.includes('/')) {
      return await selectedInstance.getSecretByNotation(secretRef);
    }

    // Otherwise use simple field access
    const targetField = field || explicitField;
    return await selectedInstance.getSecretField(recordRef, targetField);
  },
});
