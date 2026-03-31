import { Resolver, plugin } from 'varlock/plugin-lib';

import { KdbxReader, sanitizeEnvKey } from './kdbx-reader';
import { KpCliReader } from './cli-helper';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const KP_ICON = 'simple-icons:keepassxc';

plugin.name = 'keepass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KP_ICON;

/** Shared interface for both file-mode and CLI-mode readers */
interface KpReader {
  readEntry(entryPath: string, attribute?: string): Promise<string>;
  listEntries(groupPath?: string): Promise<Array<string>>;
}

class KeePassPluginInstance {
  private reader?: KpReader;
  private readerMode?: 'file' | 'cli';

  constructor(
    readonly id: string,
  ) {}

  configure(dbPath: string, password: string, keyFile?: string, useCli?: boolean) {
    debug('keepass instance', this.id, 'configured - dbPath:', dbPath, 'useCli:', !!useCli);

    if (useCli) {
      this.reader = new KpCliReader(dbPath, password, keyFile);
      this.readerMode = 'cli';
    } else {
      this.reader = new KdbxReader(dbPath, password, keyFile);
      this.readerMode = 'file';
    }
  }

  async readEntry(entryPath: string, attribute: string = 'Password'): Promise<string> {
    return await this.reader!.readEntry(entryPath, attribute);
  }

  async readCustomAttributes(entryPath: string): Promise<string> {
    if (this.readerMode === 'cli') {
      throw new ResolutionError('customAttributesObj is not supported in CLI mode (useCli=true)');
    }
    return await (this.reader as KdbxReader).readCustomAttributes(entryPath);
  }

  async readAllEntries(groupPath?: string): Promise<string> {
    const entryPaths = await this.reader!.listEntries(groupPath);
    const result: Record<string, string> = {};
    await Promise.all(entryPaths.map(async (entryPath) => {
      try {
        result[sanitizeEnvKey(entryPath)] = await this.reader!.readEntry(entryPath);
      } catch {
        // Skip entries that don't have the Password attribute
      }
    }));
    return JSON.stringify(result);
  }
}

const pluginInstances: Record<string, KeePassPluginInstance> = {};

function getPluginInstance(instanceId: string, resolverName: string): KeePassPluginInstance {
  if (!Object.keys(pluginInstances).length) {
    throw new SchemaError('No KeePass plugin instances found', {
      tip: 'Initialize at least one KeePass plugin instance using the @initKeePass() root decorator',
    });
  }

  const instance = pluginInstances[instanceId];
  if (!instance) {
    if (instanceId === '_default') {
      throw new SchemaError('KeePass plugin instance (without id) not found', {
        tip: [
          'Either remove the `id` param from your @initKeePass call',
          `or use \`${resolverName}(id, ...)\` to select an instance by id`,
          `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        ].join('\n'),
      });
    } else {
      throw new SchemaError(`KeePass plugin instance id "${instanceId}" not found`, {
        tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
      });
    }
  }
  return instance;
}


// --- Root Decorator: @initKeePass ---

plugin.registerRootDecorator({
  name: 'initKeePass',
  description: 'Initialize a KeePass plugin instance for kp() and kpBulk() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected arguments for @initKeePass');

    // id (optional, static)
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`KeePass instance with id "${id}" already initialized`);
    }
    pluginInstances[id] = new KeePassPluginInstance(id);

    // dbPath is required
    if (!objArgs.dbPath) {
      throw new SchemaError('dbPath is required for @initKeePass', {
        tip: 'Provide the path to a .kdbx file, e.g., @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)',
      });
    }

    // password is required
    if (!objArgs.password) {
      throw new SchemaError('password is required for @initKeePass', {
        tip: 'Provide the database master password, e.g., @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)',
      });
    }

    // keyFile (optional)
    if (objArgs.keyFile && !objArgs.keyFile.isStatic) {
      throw new SchemaError('Expected keyFile to be a static value');
    }

    return {
      id,
      dbPathResolver: objArgs.dbPath,
      passwordResolver: objArgs.password,
      keyFile: objArgs?.keyFile ? String(objArgs.keyFile.staticValue) : undefined,
      useCliResolver: objArgs.useCli,
    };
  },
  async execute({
    id, dbPathResolver, passwordResolver, keyFile, useCliResolver,
  }) {
    const dbPath = await dbPathResolver.resolve();
    const password = await passwordResolver.resolve();
    if (typeof dbPath !== 'string') {
      throw new SchemaError('Expected dbPath to resolve to a string');
    }
    if (typeof password !== 'string') {
      throw new SchemaError('Expected password to resolve to a string');
    }

    // useCli can be dynamic (e.g., forEnv(dev)) so we resolve it at runtime
    let useCli = false;
    if (useCliResolver) {
      const resolved = await useCliResolver.resolve();
      useCli = resolved === true || resolved === 'true';
    }

    pluginInstances[id].configure(dbPath, password, keyFile, useCli);
  },
});


// --- Data Type: kdbxPassword ---

plugin.registerDataType({
  name: 'kdbxPassword',
  sensitive: true,
  typeDescription: 'Master password for a KeePass KDBX database file',
  icon: KP_ICON,
  docs: [
    {
      description: 'KeePassXC documentation',
      url: 'https://keepassxc.org/docs/',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new ValidationError('KeePass database password must be a non-empty string');
    }
  },
});


// --- Resolver: kp() ---

plugin.registerResolverFunction({
  name: 'kp',
  label: 'Fetch a single secret from a KeePass database entry',
  icon: KP_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let entryPathResolver: Resolver | undefined;

    const attributeResolver = this.objArgs?.attribute;
    const customAttributesObjResolver = this.objArgs?.customAttributesObj;

    // always capture the parent item key for inferring entry path
    const parent = (this as any).parent;
    const inferredEntryPath: string | undefined = parent?.key || undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      instanceId = '_default';
      if (!inferredEntryPath) {
        throw new SchemaError('Could not infer entry path - no parent config item key found', {
          tip: 'Either provide an entry path argument, or ensure this is used within a config item',
        });
      }
    } else if (argCount === 1) {
      instanceId = '_default';
      entryPathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      entryPathResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    getPluginInstance(instanceId, 'kp');

    return {
      instanceId, entryPathResolver, inferredEntryPath, attributeResolver, customAttributesObjResolver,
    };
  },
  async resolve({
    instanceId, entryPathResolver, inferredEntryPath, attributeResolver, customAttributesObjResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let rawPath: string;
    if (entryPathResolver) {
      const resolved = await entryPathResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected entry path to resolve to a string');
      }
      rawPath = resolved;
    } else if (inferredEntryPath) {
      rawPath = inferredEntryPath;
    } else {
      throw new SchemaError('No entry path provided or inferred');
    }

    // parse #attribute from the path (e.g., "Entry#UserName" or "#UserName")
    // named param `attribute=` takes precedence if both are provided
    let attribute = 'Password';
    let entryPath = rawPath;
    const hashIdx = rawPath.indexOf('#');
    if (hashIdx !== -1) {
      attribute = rawPath.slice(hashIdx + 1);
      entryPath = rawPath.slice(0, hashIdx);
    }
    if (attributeResolver) {
      const resolved = await attributeResolver.resolve();
      if (typeof resolved === 'string') {
        attribute = resolved;
      }
    }

    // if entry path is empty after parsing #attribute, infer from item key
    if (!entryPath) {
      if (inferredEntryPath) {
        entryPath = inferredEntryPath;
      } else {
        throw new SchemaError('No entry path provided or inferred', {
          tip: 'Use kp("Entry#Attribute") or kp("#Attribute") within a config item to infer the entry name',
        });
      }
    }

    // if customAttributesObj=true, return all custom fields as a JSON object
    let customAttributesObj = false;
    if (customAttributesObjResolver) {
      const resolved = await customAttributesObjResolver.resolve();
      customAttributesObj = resolved === true || resolved === 'true';
    }
    if (customAttributesObj) {
      return await selectedInstance.readCustomAttributes(entryPath);
    }

    return await selectedInstance.readEntry(entryPath, attribute);
  },
});


// --- Resolver: kpBulk() ---

plugin.registerResolverFunction({
  name: 'kpBulk',
  label: 'Load all secrets from a KeePass database group as a JSON map',
  icon: KP_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let groupPathResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // kpBulk() - load all entries from root
    } else if (argCount === 1) {
      groupPathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      groupPathResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    getPluginInstance(instanceId, 'kpBulk');

    return { instanceId, groupPathResolver };
  },
  async resolve({ instanceId, groupPathResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    let groupPath: string | undefined;
    if (groupPathResolver) {
      const resolved = await groupPathResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected group path to resolve to a string');
      }
      groupPath = resolved;
    }

    return await selectedInstance.readAllEntries(groupPath);
  },
});
