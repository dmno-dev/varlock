import { Resolver } from 'varlock/plugin-lib';
import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const PASS_ICON = 'mdi:lock-outline';

plugin.name = 'pass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = PASS_ICON;

const FIX_INSTALL_TIP = [
  'The `pass` command was not found on your system.',
  'Install it using your package manager:',
  '  macOS:   brew install pass',
  '  Ubuntu:  sudo apt-get install pass',
  '  Fedora:  sudo yum install pass',
  '  Arch:    pacman -S pass',
  'See https://www.passwordstore.org/ for more info.',
].join('\n');


/**
 * Manages interaction with a local `pass` password store.
 * Handles subprocess calls, caching within a resolution session,
 * and lazy detection of the `pass` CLI.
 */
class PassPluginInstance {
  /** Custom store path (overrides PASSWORD_STORE_DIR) */
  private storePath?: string;
  /** Prefix to prepend to all entry paths */
  private namePrefix?: string;

  /** Cache of decrypted entries for the current resolution session */
  private cache = new Map<string, string>();
  /** Track whether `pass` CLI is available (lazy check) */
  private passChecked = false;

  constructor(
    readonly id: string,
  ) {}

  configure(storePath?: string, namePrefix?: string) {
    this.storePath = storePath;
    this.namePrefix = namePrefix;
    debug(
      'pass instance',
      this.id,
      'configured - storePath:',
      this.storePath || '(default)',
      'namePrefix:',
      this.namePrefix || '(none)',
    );
  }

  applyNamePrefix(name: string): string {
    if (this.namePrefix) {
      return this.namePrefix + name;
    }
    return name;
  }

  /**
   * Build spawn options with PASSWORD_STORE_DIR if a custom store path is set.
   */
  private get spawnEnv(): Record<string, string> | undefined {
    if (!this.storePath) return undefined;
    return {
      ...process.env as Record<string, string>,
      PASSWORD_STORE_DIR: this.storePath,
    };
  }

  /**
   * Lazily check that the `pass` command is available.
   * Only fails when we actually try to use it, not at plugin load time.
   */
  private async ensurePassInstalled(): Promise<void> {
    if (this.passChecked) return;
    try {
      await spawnAsync('pass', ['version'], this.spawnEnv ? { env: this.spawnEnv } : undefined);
      this.passChecked = true;
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        throw new ResolutionError('`pass` command not found', { tip: FIX_INSTALL_TIP });
      }
      // pass version might fail for other reasons (e.g. no store initialized)
      // but if the binary exists, that's fine - the actual commands will give better errors
      this.passChecked = true;
    }
  }

  /**
   * Retrieve a single entry from the pass store.
   *
   * By default returns only the first line (the password), matching pass's
   * own convention where the password is on line 1 and metadata follows.
   * Set `fullContent` to true to return all lines.
   */
  async getSecret(entryPath: string, fullContent = false): Promise<string> {
    await this.ensurePassInstalled();

    // Check cache first
    if (this.cache.has(entryPath)) {
      debug('cache hit for', entryPath);
      const cached = this.cache.get(entryPath)!;
      if (fullContent) return cached;
      return cached.split('\n')[0];
    }

    try {
      debug('fetching pass entry:', entryPath);
      const result = await spawnAsync(
        'pass',
        ['show', entryPath],
        this.spawnEnv ? { env: this.spawnEnv } : undefined,
      );

      // Trim trailing whitespace/newlines that the shell may add
      const value = result.trimEnd();
      // Cache the full content; callers can request first line only
      this.cache.set(entryPath, value);
      if (fullContent) return value;
      return value.split('\n')[0];
    } catch (err) {
      return this.handlePassError(err, entryPath);
    }
  }

  /**
   * List all entry paths under a given prefix in the pass store.
   * Returns an array of full entry paths (relative to store root).
   */
  async listEntries(pathPrefix?: string): Promise<Array<string>> {
    await this.ensurePassInstalled();

    try {
      const args = pathPrefix ? ['ls', pathPrefix] : ['ls'];
      debug('listing pass entries:', pathPrefix || '(root)');
      const result = await spawnAsync(
        'pass',
        args,
        this.spawnEnv ? { env: this.spawnEnv } : undefined,
      );

      return this.parseTreeOutput(result, pathPrefix);
    } catch (err) {
      if (err instanceof ExecError) {
        const errMsg = err.data || err.message;
        if (errMsg.includes('is not in the password store') || errMsg.includes('password store is empty')) {
          return [];
        }
      }
      throw err;
    }
  }

  /**
   * Retrieve all entries under a given prefix, returning them as a JSON map.
   * Keys are entry paths (relative to store root), values are first line (password) of each entry.
   */
  async getAllSecrets(pathPrefix?: string): Promise<string> {
    const entries = await this.listEntries(pathPrefix);
    debug('bulk fetching', entries.length, 'entries under', pathPrefix || '(root)');

    const result: Record<string, string> = {};
    // Fetch all entries in parallel (first line only, matching pass convention)
    const fetchPromises = entries.map(async (entryPath) => {
      const value = await this.getSecret(entryPath);
      result[entryPath] = value;
    });
    await Promise.all(fetchPromises);

    return JSON.stringify(result);
  }

  /**
   * Parse the tree-formatted output from `pass ls` into an array of entry paths.
   *
   * Example input:
   * ```
   * Password Store
   * ├── services
   * │   ├── db
   * │   │   └── password
   * │   └── api-key
   * └── email
   * ```
   *
   * The tree uses box-drawing characters (├──, └──, │) and indentation.
   * We need to track the depth/indentation to reconstruct full paths.
   */
  private parseTreeOutput(output: string, pathPrefix?: string): Array<string> {
    const lines = output.split('\n');
    const entries: Array<string> = [];

    // Track the current path stack based on indentation levels
    const pathStack: Array<string> = [];

    for (const line of lines) {
      // Skip empty lines and the header line (e.g., "Password Store" or prefix name)
      if (!line.trim()) continue;

      // Detect indentation level by looking for tree characters
      // Each level of nesting adds "│   " or "    " (4 chars)
      // The actual entry is after "├── " or "└── "
      const treeMatch = line.match(/^((?:[│ ] {3})*)[├└]── (.+)$/);
      if (!treeMatch) continue;

      const indentStr = treeMatch[1];
      const name = treeMatch[2].trim();

      // Calculate depth from indentation (each level is 4 chars: "│   " or "    ")
      const depth = indentStr.length / 4;

      // Trim the path stack to the current depth
      pathStack.length = depth;
      pathStack.push(name);

      // We can't easily tell directories from files in tree output.
      // Directories will have children below them, so we'll collect everything
      // and later only keep the leaf nodes (entries without children).
      // Actually, `pass ls` only shows files (entries) as leaves.
      // Directories always have children, so we just track leaves.
      entries.push(pathStack.join('/'));
    }

    // Filter to only leaf entries (i.e., entries that are not prefixes of other entries)
    const leafEntries = entries.filter((entry) => {
      return !entries.some((other) => other !== entry && other.startsWith(`${entry}/`));
    });

    // If a prefix was given, entries are relative to it but we want full paths
    if (pathPrefix) {
      return leafEntries.map((entry) => `${pathPrefix}/${entry}`);
    }
    return leafEntries;
  }

  /**
   * Handle errors from `pass` CLI commands with helpful messages.
   */
  private handlePassError(err: unknown, entryPath: string): never {
    if (err instanceof ExecError) {
      const errMsg = err.data || err.message;

      if (errMsg.includes('is not in the password store')) {
        throw new ResolutionError(`Entry "${entryPath}" not found in pass store`, {
          tip: [
            `Verify the entry exists: pass show ${entryPath}`,
            'List available entries: pass ls',
          ].join('\n'),
        });
      }

      if (errMsg.includes('password store is empty')) {
        throw new ResolutionError('Password store is empty or not initialized', {
          tip: [
            'Initialize your password store: pass init "Your GPG Key ID"',
            'See: pass init --help',
          ].join('\n'),
        });
      }

      if (errMsg.includes('sneaky path')) {
        throw new ResolutionError(`Invalid entry path "${entryPath}" - path traversal detected`, {
          tip: 'Entry paths must not contain ".." or other directory traversal patterns',
        });
      }

      if (errMsg.includes('gpg') || errMsg.includes('GPG') || errMsg.includes('decryption')) {
        throw new ResolutionError(`GPG decryption failed for entry "${entryPath}"`, {
          tip: [
            'Ensure your GPG key is available and the agent is running:',
            '  gpg --list-keys',
            '  gpgconf --launch gpg-agent',
            'You may need to enter your GPG passphrase.',
          ].join('\n'),
        });
      }

      throw new ResolutionError(`Failed to fetch pass entry "${entryPath}": ${errMsg}`);
    }

    if ((err as any).code === 'ENOENT') {
      throw new ResolutionError('`pass` command not found', { tip: FIX_INSTALL_TIP });
    }

    throw new ResolutionError(`Failed to fetch pass entry "${entryPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}


// --- Plugin Instances ---

const pluginInstances: Record<string, PassPluginInstance> = {};


// --- Root Decorator: @initPass ---

plugin.registerRootDecorator({
  name: 'initPass',
  description: 'Initialize a pass password store plugin instance for pass() and passBulk() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;

    // Validate id is static (if provided)
    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    // Validate storePath is static (if provided)
    if (objArgs?.storePath && !objArgs.storePath.isStatic) {
      throw new SchemaError('Expected storePath to be static');
    }
    const storePath = objArgs?.storePath ? String(objArgs.storePath.staticValue) : undefined;

    // Validate namePrefix is static (if provided)
    if (objArgs?.namePrefix && !objArgs.namePrefix.isStatic) {
      throw new SchemaError('Expected namePrefix to be static');
    }
    const namePrefix = objArgs?.namePrefix ? String(objArgs.namePrefix.staticValue) : undefined;

    pluginInstances[id] = new PassPluginInstance(id);

    return { id, storePath, namePrefix };
  },
  async execute({ id, storePath, namePrefix }) {
    pluginInstances[id].configure(storePath, namePrefix);
  },
});


// --- Resolver: pass() ---

plugin.registerResolverFunction({
  name: 'pass',
  label: 'Fetch secret from pass (the standard unix password manager)',
  icon: PASS_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let entryPathResolver: Resolver | undefined;
    let inferredEntryPath: string | undefined;

    // Check for named `allowMissing` parameter
    const allowMissingResolver = this.objArgs?.allowMissing;

    // Check for named `multiline` parameter (returns all lines instead of just first)
    const multilineResolver = this.objArgs?.multiline;

    // Parse positional arguments
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // pass() - auto-infer entry path from parent config item key
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer entry path - no parent config item key found', {
          tip: 'Either provide an entry path as an argument, or ensure this is used within a config item',
        });
      }
      inferredEntryPath = itemKey;
    } else if (argCount === 1) {
      // pass("entry/path")
      instanceId = '_default';
      entryPathResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // pass(instanceId, "entry/path")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      entryPathResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    // Validate instance exists
    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No pass plugin instances found', {
        tip: 'Initialize at least one pass plugin instance using the @initPass() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Pass plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initPass call',
            'or use `pass(id, entryPath)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Pass plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, entryPathResolver, inferredEntryPath, allowMissingResolver, multilineResolver,
    };
  },
  async resolve({
    instanceId, entryPathResolver, inferredEntryPath, allowMissingResolver, multilineResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    // Resolve the entry path
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

    // Apply name prefix
    const finalPath = selectedInstance.applyNamePrefix(entryPath);

    // Resolve allowMissing
    let allowMissing = false;
    if (allowMissingResolver) {
      const resolved = await allowMissingResolver.resolve();
      allowMissing = resolved === true || resolved === 'true';
    }

    // Resolve multiline
    let multiline = false;
    if (multilineResolver) {
      const resolved = await multilineResolver.resolve();
      multiline = resolved === true || resolved === 'true';
    }

    try {
      return await selectedInstance.getSecret(finalPath, multiline);
    } catch (err) {
      if (allowMissing && err instanceof ResolutionError && err.message.includes('not found')) {
        return '';
      }
      throw err;
    }
  },
});


// --- Resolver: passBulk() ---

plugin.registerResolverFunction({
  name: 'passBulk',
  label: 'Load all secrets from a pass store directory as a JSON map',
  icon: PASS_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let pathPrefixResolver: Resolver | undefined;

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // passBulk() - load all entries from store root
      // no-op, defaults are fine
    } else if (argCount === 1) {
      // passBulk("path/prefix") - load entries under prefix
      pathPrefixResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // passBulk(instanceId, "path/prefix")
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      pathPrefixResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No pass plugin instances found', {
        tip: 'Initialize at least one pass plugin instance using the @initPass() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Pass plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initPass call',
            'or use `passBulk(id, pathPrefix)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Pass plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, pathPrefixResolver };
  },
  async resolve({ instanceId, pathPrefixResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    let pathPrefix: string | undefined;
    if (pathPrefixResolver) {
      const resolved = await pathPrefixResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected path prefix to resolve to a string');
      }
      pathPrefix = resolved;
    }

    // Apply name prefix to the path prefix if set
    pathPrefix &&= selectedInstance.applyNamePrefix(pathPrefix);

    return await selectedInstance.getAllSecrets(pathPrefix);
  },
});
