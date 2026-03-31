import { type Resolver, plugin } from 'varlock/plugin-lib';
import { PassboltClient, type UUIDv4String } from './passbolt';
import type { Resource } from './types';

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

  constructor(readonly id: string) {}

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

      throw new SchemaError('Failed to initialize Passbolt client', {
        tip: 'Verify accountKit and passphrase are correct',
      });
    })();

    return this.passboltClientPromise;
  }

  private returnResourceField(resource: Resource, field?: string) {
    field ??= 'password';

    switch (field) {
      case 'username':
      case 'uri':
      case 'password':
        if (!resource[field]) {
          throw new ResolutionError(`Resource ${resource.id} has no ${field}`);
        }
        return resource[field];
      case 'totp.secret':
      case 'totp.code':
        if (!resource.totp) {
          throw new ResolutionError(`Resource ${resource.id} has no totp`);
        }
        return field === 'totp.secret' ? resource.totp.secretKey : resource.totp.code;
      default:
        if (field.startsWith('totp.')) {
          throw new SchemaError(`Invalid totp field "${field}"`, {
            tip: 'Valid totp fields are "totp.secret" and "totp.code"',
          });
        }
        // any other unrecognized field name is treated as a custom field
        if (!resource.customFields) {
          throw new ResolutionError(`Resource ${resource.id} has no custom fields`);
        }
        if (!resource.customFields[field]) {
          throw new ResolutionError(`Resource ${resource.id} has no custom field "${field}"`);
        }
        return resource.customFields[field];
    }
  }

  async getResource(resourceId: UUIDv4String, field?: string): Promise<string | undefined> {
    const client = await this.initClient();
    const resource = await client.getResource(resourceId);

    if (!resource) {
      throw new ResolutionError(`No resource with id ${resourceId} found`);
    }

    return this.returnResourceField(resource, field);
  }

  async getBulkResources(folderPath: string): Promise<string> {
    const client = await this.initClient();
    const folderId = await client.findFolder(folderPath);

    if (!folderId) {
      throw new ResolutionError(`Folder "${folderPath}" does not exist or user has no access`);
    }

    const resources = await client.getResources(folderId);

    if (resources.length === 0) {
      throw new ResolutionError(`No resources found in folder "${folderPath}" or user has no access`);
    }

    const result: Record<string, string> = {};
    for (const resource of resources) {
      if (resource.password) {
        result[resource.name] = resource.password;
      }
    }

    return JSON.stringify(result);
  }

  async getCustomFieldObj(resourceId: UUIDv4String): Promise<string> {
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
  if (Object.keys(pluginInstances).length === 0) {
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
    instanceId, resolver, fieldResolver,
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
    const { instanceId, resolver, fieldResolver } = processResolver(this, 'passbolt(id, resourceId)');

    return { instanceId, resourceIdResolver: resolver, fieldResolver };
  },
  async resolve({ instanceId, resourceIdResolver, fieldResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const { resourceId, field } = await resolveResourceId(resourceIdResolver);

    return await selectedInstance.getResource(resourceId, field ?? await fieldResolver?.resolve());
  },
});

plugin.registerResolverFunction({
  name: 'passboltBulk',
  label: 'Load all secrets from a Passbolt folder',
  icon: PASSBOLT_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 1,
  },
  process() {
    let instanceId = '_default';
    const { folderPath: folderPathResolver } = this.objArgs ?? {};

    if (this.arrArgs?.length === 1) {
      if (!this.arrArgs[0].isStatic) {
        throw new SchemaError('Expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs[0].staticValue);
    }

    if (!folderPathResolver) {
      throw new SchemaError('folderPath is required', {
        tip: 'Usage: passboltBulk(folderPath="MyFolder/SubFolder")',
      });
    }

    if (!pluginInstances[instanceId]) {
      throw new SchemaError(`Passbolt plugin instance "${instanceId}" not found`);
    }

    return { instanceId, folderPathResolver };
  },
  async resolve({ instanceId, folderPathResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const folderPath = await folderPathResolver.resolve();
    if (typeof folderPath !== 'string') {
      throw new SchemaError('Expected folderPath to resolve to a string');
    }

    return await selectedInstance.getBulkResources(folderPath);
  },
});

plugin.registerResolverFunction({
  name: 'passboltCustomFieldsObj',
  label: 'Load custom fields from a Passbolt resource as a JSON object',
  icon: PASSBOLT_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    const { instanceId, resolver } = processResolver(this, 'passboltCustomFieldsObj(id, resourceId)');

    return { instanceId, resourceIdResolver: resolver };
  },
  async resolve({ instanceId, resourceIdResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const { resourceId } = await resolveResourceId(resourceIdResolver);

    return await selectedInstance.getCustomFieldObj(resourceId);
  },
});
