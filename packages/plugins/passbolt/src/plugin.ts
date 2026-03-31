import { Resolver, plugin } from 'varlock/plugin-lib';
import { PassboltClient, type UUIDv4String } from './passbolt';
import { Resource } from './types';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const PASSBOLT_ICON = 'simple-icons:passbolt';

plugin.name = 'passbolt';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = PASSBOLT_ICON;
plugin.standardVars = {
  initDecorator: '@initPassbolt',
  params: {
    accountKit: { key: 'PB_ACCOUNT_KIT', dataType: 'passboltAccountKit' },
    passphrase: { key: 'PB_PASSPHRASE' },
  },
};

class PassboltPluginInstance {
  private accountKit?: string;
  private passphrase?: string;

  constructor(readonly id: string) {

  }

  setAuth(accountKit?: any, passphrase?: any) {
    this.accountKit = accountKit?.toString?.() ?? undefined;
    this.passphrase = passphrase?.toString?.() ?? undefined;

    debug('passbolt instance', this.id, 'hasAccountKit', !!this.accountKit, 'hasPassphrase:', !!this.passphrase);
  }

  private passboltClientPromise?: Promise<PassboltClient>;

  private async initClient() {
    if (this.passboltClientPromise) {
      return this.passboltClientPromise;
    }

    if (!this.accountKit || !this.passphrase) {
      throw new SchemaError('Passbolt accountKit and passphrase are required', {
        tip: 'Set accountKit and passphrase in @initPassbolt() decorator',
      });
    }

    this.passboltClientPromise = (async () => {
      const client = await PassboltClient.instantiateWithAccountKit(this.accountKit!, this.passphrase!);

      await client.init();

      if (client.isInitialized) {
        debug('Passbolt client initialized successfully');
        return client;
      }

      throw new SchemaError('Failed to initialize Passbolt client:', {
        tip: 'Verify accountKit and passphrase are correct',
      });
    })();

    return this.passboltClientPromise;
  }

  isValidField(field: string, inferred?: string) {
    return [
      ['username', 'password', 'uri', 'totp.secret', 'totp.code'].includes(field),
      field === 'custom' && typeof inferred === 'string',
      field.startsWith('custom.') && field.length > 7,
    ].some(Boolean);
  }

  private returnResourceField(resource: Resource, field?: string, inferred?: string) {
    let value: string | undefined;

    field ??= 'password';

    if (!this.isValidField(field, inferred)) {
      throw new SchemaError(`Invalid field "${field}"`, {
        tip: [
          'Valid fields are \'username\', \'password\', \'uri\', \'totp.secret\', \'totp.code\', \'custom\' and',
          'fields starting with custom.',
        ].join('\n'),
      });
    }

    switch (field) {
      case 'username':
      case 'uri':
      case 'password':
        if (!resource[field]) {
          throw new ResolutionError(`Resource ${resource.id} has no ${field}`);
        }
        value = resource[field];
        break;
      case 'totp.secret':
      case 'totp.code':
        if (!resource.totp) {
          throw new ResolutionError(`Resource ${resource.id} has no totp`);
        }
        value = field === 'totp.secret' ? resource.totp.secretKey : resource.totp.code;
        break;
      default:
        if (!resource.customFields) {
          throw new ResolutionError(`Resource ${resource.id} has no custom fields`);
        }

        if (field === 'custom') {
          if (!inferred) {
            throw new SchemaError('Could not infer custom field name');
          } else if (!resource.customFields[inferred]) {
            throw new ResolutionError(`Resource ${resource.id} has no custom field ${inferred}`);
          }
          value = resource.customFields[inferred];
        } else {
          const customField = field.slice(7);

          if (!resource.customFields[customField]) {
            throw new ResolutionError(`Resource ${resource.id} has no custom field ${customField}`);
          }

          value = resource.customFields[customField];
        }
    }

    return value;
  }

  async getResource(resourceId: UUIDv4String, field?: string, inferred?: string): Promise<string | undefined> {
    const client = await this.initClient();
    const resource = await client.getResource(resourceId);

    if (!resource) {
      throw new ResolutionError(`No resource with id ${resourceId} found`);
    }

    return this.returnResourceField(resource, field, inferred);
  }

  async getBulkResources(folder: string, field?: string): Promise<string> {
    const client = await this.initClient();
    const folderId = await client.findFolder(folder);

    if (!folderId) {
      throw new ResolutionError(`Folder ${folder} does not exist or user has no access`);
    }

    const resources = await client.getResources(folderId);

    if (resources.length === 0) {
      throw new ResolutionError(`No resources found in Folder ${folder} or user has no access`);
    }

    field ??= 'password';

    if (!['username', 'password', 'uri', 'totp.secret', 'totp.code'].includes(field)) {
      throw new SchemaError(`Field "${field}" is invalid for passboltFolder`, {
        tip: 'Valid fields are \'username\', \'password\', \'uri\', \'totp.secret\' and \'totp.code\'',
      });
    }

    const result: Record<string, string> = {};

    for (const resource of resources) {
      let value: string | undefined;

      if (field === 'totp.secret' || field === 'totp.code') {
        value = field === 'totp.secret' ? resource.totp?.secretKey : resource.totp?.code;
      } else {
        value = resource[field as 'username' | 'uri' | 'password'];
      }

      if (value) {
        result[resource.name] = value;
      }
    }

    return JSON.stringify(result);
  }

  async getBulkResource(resourceId: UUIDv4String): Promise<string> {
    const client = await this.initClient();
    const result = await client.getResource(resourceId);

    if (!result?.customFields) {
      throw new ResolutionError(`Resource ${resourceId} has no custom fields`);
    }

    return JSON.stringify(result.customFields);
  }
}

const pluginInstances: Record<string, PassboltPluginInstance> = {};

function processResolver(scope: any, text: string) {
  let instanceId = '_default';
  let resolver: Resolver;
  const inferredParamName: string | undefined = (scope as any).parent?.key;

  const { field: fieldResolver } = scope.objArgs ?? {};

  if (scope.arrArgs!.length === 1) {
    resolver = scope.arrArgs![0];
  } else if (scope.arrArgs!.length === 2) {
    if (!scope.arrArgs![0].isStatic) {
      throw new SchemaError('Expected instance id (first argument) to be a static value');
    }
    instanceId = String(scope.arrArgs![0].staticValue);
    resolver = scope.arrArgs![1];
  } else {
    throw new SchemaError('Expected 1-2 arguments');
  }

  // Validate instance exists
  if (!Object.values(pluginInstances).length) {
    throw new SchemaError('No Passbolt plugin instances found', {
      tip: 'Initialize at least one Passbolt plugin instance using @initPassbolt() decorator',
    });
  }

  const selectedInstance = pluginInstances[instanceId];

  if (!selectedInstance) {
    if (instanceId === '_default') {
      throw new SchemaError('Passbolt plugin instance (without id) not found', {
        tip: [
          'Either remove the `id` param from your @initPassbolt call',
          `or use \`${text}\` to select an instance by id`,
          `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        ].join('\n'),
      });
    } else {
      throw new SchemaError(`Passbolt plugin instance id "${instanceId}" not found`, {
        tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
      });
    }
  }

  return {
    instanceId, resolver, fieldResolver, inferredParamName,
  };
}

async function resolveResourceId(resolver: Resolver): Promise<{ resourceId: UUIDv4String, field?: string }> {
  const resolvedValue = await resolver.resolve();

  if (typeof resolvedValue !== 'string') {
    throw new SchemaError('Expected resource ID to resolve to a string');
  }

  const [resourceId, field] = resolvedValue.split('#');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[8-9a-b][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId)) {
    throw new SchemaError(`Invalid resource ID format: "${resourceId}"`, {
      tip: 'Resource ID must be a valid UUID v4 (e.g., "01234567-0123-4567-890a-bcdef0123456")',
    });
  }

  return { resourceId: resourceId as UUIDv4String, field };
}

async function resolveFolder(resolver: Resolver): Promise<{ folder: string, field?: string }> {
  const resolvedValue = await resolver.resolve();

  if (typeof resolvedValue !== 'string') {
    throw new SchemaError('Expected folder to resolve to a string');
  }

  const [folder, field] = resolvedValue.split('#');

  return { folder, field };
}

plugin.registerRootDecorator({
  name: 'initPassbolt',
  description: 'Initialize a Passbolt plugin instance for passbolt() resolver',
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

    if (!objArgs.accountKit) {
      throw new SchemaError('accountKit is required', {
        tip: 'Add accountKit parameter: @initPassbolt(accountKit=$PB_ACCOUNT_KIT)',
      });
    }

    if (!objArgs.passphrase) {
      throw new SchemaError('passphrase is required', {
        tip: 'Add passphrase parameter: @initPassbolt(passphrase=$PB_PASSPHRASE)',
      });
    }

    pluginInstances[id] = new PassboltPluginInstance(id);

    return { id, accountKitResolver: objArgs.accountKit, passphraseResolver: objArgs.passphrase };
  },
  async execute({ id, accountKitResolver, passphraseResolver }) {
    const accountKit = await accountKitResolver?.resolve();
    const passphrase = await passphraseResolver?.resolve();

    pluginInstances[id].setAuth(accountKit, passphrase);
  },
});

plugin.registerDataType({
  name: 'passboltAccountKit',
  sensitive: true,
  typeDescription: 'Passbolt accountKit for authentication',
  icon: PASSBOLT_ICON,
  async validate(val: any): Promise<true> {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(val)) {
      throw new ValidationError('Must be a valid Passbolt account kit');
    }
    return true;
  },
});

plugin.registerResolverFunction({
  name: 'passbolt',
  label: 'Fetch secret value from Passbolt',
  icon: PASSBOLT_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    const {
      instanceId, resolver, fieldResolver, inferredParamName,
    } = processResolver(this, 'passbolt(id, resourceId)');

    return {
      instanceId, resourceIdResolver: resolver, fieldResolver, inferredParamName,
    };
  },
  async resolve({
    instanceId, resourceIdResolver, fieldResolver, inferredParamName,
  }) {
    const selectedInstance = await pluginInstances[instanceId];
    const { resourceId, field } = await resolveResourceId(resourceIdResolver);

    return await selectedInstance.getResource(resourceId, field ?? await fieldResolver?.resolve(), inferredParamName);
  },
});

plugin.registerResolverFunction({
  name: 'passboltFolder',
  label: 'Load all secrets from an Passbolt folder',
  icon: PASSBOLT_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    const { instanceId, resolver, fieldResolver } = processResolver(this, 'passboltFolder(id, folder)');

    return { instanceId, folderResolver: resolver, fieldResolver };
  },
  async resolve({ instanceId, folderResolver, fieldResolver }) {
    const selectedInstance = await pluginInstances[instanceId];
    const { folder } = await resolveFolder(folderResolver);

    return await selectedInstance.getBulkResources(folder, await fieldResolver?.resolve());
  },
});

plugin.registerResolverFunction({
  name: 'passboltCustomFields',
  label: 'Load all secrets from a Passbolt resource with custom fields',
  icon: PASSBOLT_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    const { instanceId, resolver } = processResolver(this, 'passboltCustomFields(id, resourceId)');

    return { instanceId, resourceIdResolver: resolver };
  },
  async resolve({ instanceId, resourceIdResolver }) {
    const selectedInstance = await pluginInstances[instanceId];
    const { resourceId } = await resolveResourceId(resourceIdResolver);

    return await selectedInstance.getBulkResource(resourceId);
  },
});
