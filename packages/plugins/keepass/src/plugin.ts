import { Resolver } from 'varlock/plugin-lib';

import { KdbxReader, sanitizeEnvKey } from './kdbx-reader';
import { configureCliAuth, kpCliRead, kpCliList } from './cli-helper';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const KP_ICON = 'simple-icons:keepassxc';

plugin.name = 'keepass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KP_ICON;

/**
 * A KeePass plugin instance handles reading secrets from a KDBX database.
 *
 * Two modes of operation:
 * - **File mode (production)**: Opens and reads KDBX 4.0 files directly using kdbxweb.
 *   Requires `dbPath` and `password` (and optionally `keyFile`).
 * - **CLI mode (development)**: Uses `keepassxc-cli` to read entries from a database.
 *   Requires `dbPath`, `password`, and optionally `keyFile`.
 *   When `useDesktopApp=true`, uses the CLI to interact with the database,
 *   which allows leveraging system-level key management (YubiKey, etc.).
 */
class KeePassPluginInstance {
  private dbPath?: string;
  private password?: string;
  private keyFile?: string;
  private useDesktopApp?: boolean;
  private kdbxReader?: KdbxReader;

  constructor(
    readonly id: string,
  ) {}

  configure(dbPath: string, password: string, keyFile?: string, useDesktopApp?: boolean) {
    this.dbPath = dbPath;
    this.password = password;
    this.keyFile = keyFile;
    this.useDesktopApp = useDesktopApp;
    debug('keepass instance', this.id, 'configured - dbPath:', this.dbPath, 'useDesktopApp:', !!this.useDesktopApp);

    if (this.useDesktopApp) {
      configureCliAuth(dbPath, password, keyFile);
    } else {
      this.kdbxReader = new KdbxReader(dbPath, password, keyFile);
    }
  }

  async readEntry(entryPath: string, attribute: string = 'Password'): Promise<string> {
    if (!this.dbPath || !this.password) {
      throw new ResolutionError('KeePass plugin instance not configured', {
        tip: `Plugin instance (${this.id}) must have dbPath and password set via @initKeePass`,
      });
    }

    if (this.useDesktopApp) {
      return await kpCliRead(entryPath, attribute);
    } else if (this.kdbxReader) {
      return await this.kdbxReader.readEntry(entryPath, attribute);
    } else {
      throw new SchemaError('KeePass plugin instance not properly initialized');
    }
  }

  async listEntries(groupPath?: string): Promise<Array<string>> {
    if (!this.dbPath || !this.password) {
      throw new ResolutionError('KeePass plugin instance not configured');
    }

    if (this.useDesktopApp) {
      return await kpCliList(groupPath);
    } else if (this.kdbxReader) {
      return await this.kdbxReader.listEntries(groupPath);
    } else {
      throw new SchemaError('KeePass plugin instance not properly initialized');
    }
  }

  async readAllEntries(groupPath?: string, attribute: string = 'Password'): Promise<string> {
    if (!this.dbPath || !this.password) {
      throw new ResolutionError('KeePass plugin instance not configured');
    }

    if (this.useDesktopApp) {
      // CLI mode: list entries then read each one
      const entries = await kpCliList(groupPath);
      const result: Record<string, string> = {};
      await Promise.all(entries.map(async (path) => {
        try {
          result[sanitizeEnvKey(path, attribute)] = await kpCliRead(path, attribute);
        } catch {
          // Skip entries that don't have the requested attribute
        }
      }));
      return JSON.stringify(result);
    } else if (this.kdbxReader) {
      return await this.kdbxReader.readAllEntries(groupPath, attribute);
    } else {
      throw new SchemaError('KeePass plugin instance not properly initialized');
    }
  }
}

const pluginInstances: Record<string, KeePassPluginInstance> = {};


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

    // useDesktopApp (optional, static) - when true, uses keepassxc-cli instead of reading the file directly
    if (objArgs.useDesktopApp && !objArgs.useDesktopApp.isStatic) {
      throw new SchemaError('Expected useDesktopApp to be static');
    }
    const useDesktopApp = objArgs.useDesktopApp?.staticValue === true
      || objArgs.useDesktopApp?.staticValue === 'true';

    return {
      id,
      dbPathResolver: objArgs.dbPath,
      passwordResolver: objArgs.password,
      keyFile: objArgs?.keyFile ? String(objArgs.keyFile.staticValue) : undefined,
      useDesktopApp,
    };
  },
  async execute({
    id, dbPathResolver, passwordResolver, keyFile, useDesktopApp,
  }) {
    const dbPath = await dbPathResolver.resolve();
    const password = await passwordResolver.resolve();
    if (typeof dbPath !== 'string') {
      throw new SchemaError('Expected dbPath to resolve to a string');
    }
    if (typeof password !== 'string') {
      throw new SchemaError('Expected password to resolve to a string');
    }
    pluginInstances[id].configure(dbPath, password, keyFile, useDesktopApp);
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
    let inferredEntryPath: string | undefined;

    // Named parameter: attribute (defaults to "Password")
    const attributeResolver = this.objArgs?.attribute;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // kp() - auto-infer entry path from parent config item key
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer entry path - no parent config item key found', {
          tip: 'Either provide an entry path argument, or ensure this is used within a config item',
        });
      }
      inferredEntryPath = itemKey;
    } else if (argCount === 1) {
      // kp("Group/Entry")
      instanceId = '_default';
      entryPathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // kp(instanceId, "Group/Entry")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      entryPathResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No KeePass plugin instances found', {
        tip: 'Initialize at least one KeePass plugin instance using the @initKeePass() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('KeePass plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initKeePass call',
            'or use `kp(id, entryPath)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`KeePass plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, entryPathResolver, inferredEntryPath, attributeResolver,
    };
  },
  async resolve({
    instanceId, entryPathResolver, inferredEntryPath, attributeResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let entryPath: string;
    if (entryPathResolver) {
      const resolved = await entryPathResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected entry path to resolve to a string');
      }
      entryPath = resolved;
    } else if (inferredEntryPath) {
      entryPath = inferredEntryPath;
    } else {
      throw new SchemaError('No entry path provided or inferred');
    }

    let attribute = 'Password';
    if (attributeResolver) {
      const resolved = await attributeResolver.resolve();
      if (typeof resolved === 'string') {
        attribute = resolved;
      }
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

    // Named parameter: attribute (defaults to "Password")
    const attributeResolver = this.objArgs?.attribute;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // kpBulk() - load all entries from root
    } else if (argCount === 1) {
      // kpBulk("Group/SubGroup")
      groupPathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // kpBulk(instanceId, "Group/SubGroup")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      groupPathResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No KeePass plugin instances found', {
        tip: 'Initialize at least one KeePass plugin instance using the @initKeePass() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('KeePass plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initKeePass call',
            'or use `kpBulk(id, groupPath)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`KeePass plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, groupPathResolver, attributeResolver };
  },
  async resolve({ instanceId, groupPathResolver, attributeResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    let groupPath: string | undefined;
    if (groupPathResolver) {
      const resolved = await groupPathResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected group path to resolve to a string');
      }
      groupPath = resolved;
    }

    let attribute = 'Password';
    if (attributeResolver) {
      const resolved = await attributeResolver.resolve();
      if (typeof resolved === 'string') {
        attribute = resolved;
      }
    }

    return await selectedInstance.readAllEntries(groupPath, attribute);
  },
});
