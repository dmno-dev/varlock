import { type Resolver, plugin } from 'varlock/plugin-lib';
import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const KEYCHAIN_ICON = 'simple-icons:apple';

plugin.name = 'apple-keychain';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KEYCHAIN_ICON;


class KeychainPluginInstance {
  private service?: string;
  private account?: string;
  /** Specific keychain file to search (e.g., login.keychain-db) */
  private keychainPath?: string;

  private cache = new Map<string, string>();
  private securityChecked = false;

  constructor(
    readonly id: string,
  ) {}

  configure(opts: { service?: string; account?: string; keychainPath?: string }) {
    this.service = opts.service;
    this.account = opts.account;
    this.keychainPath = opts.keychainPath;
    debug(
      'keychain instance',
      this.id,
      'configured - service:',
      this.service || '(none)',
      'account:',
      this.account || '(none)',
      'keychainPath:',
      this.keychainPath || '(default)',
    );
  }

  private async ensureSecurityAvailable(): Promise<void> {
    if (this.securityChecked) return;

    if (process.platform !== 'darwin') {
      throw new ResolutionError('Apple Keychain is only available on macOS', {
        tip: 'This plugin requires macOS. For cross-platform secret storage, consider a different plugin.',
      });
    }

    try {
      await spawnAsync('security', ['help']);
      this.securityChecked = true;
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        throw new ResolutionError('`security` command not found', {
          tip: 'The `security` CLI should be available on all macOS installations. Check your PATH.',
        });
      }
      // `security help` exits non-zero but that means the binary exists
      this.securityChecked = true;
    }
  }

  async getGenericPassword(service: string, account?: string): Promise<string> {
    await this.ensureSecurityAvailable();

    const effectiveAccount = account || this.account;
    const cacheKey = `generic:${service}:${effectiveAccount || ''}`;

    if (this.cache.has(cacheKey)) {
      debug('cache hit for', cacheKey);
      return this.cache.get(cacheKey)!;
    }

    const args = ['find-generic-password', '-s', service];
    if (effectiveAccount) {
      args.push('-a', effectiveAccount);
    }
    args.push('-w');
    if (this.keychainPath) {
      args.push(this.keychainPath);
    }

    try {
      debug('fetching generic password: service=%s account=%s', service, effectiveAccount || '(any)');
      const result = await spawnAsync('security', args);
      const value = result.trimEnd();
      this.cache.set(cacheKey, value);
      return value;
    } catch (err) {
      return this.handleSecurityError(err, 'generic', service, effectiveAccount);
    }
  }

  async getInternetPassword(server: string, account?: string): Promise<string> {
    await this.ensureSecurityAvailable();

    const effectiveAccount = account || this.account;
    const cacheKey = `internet:${server}:${effectiveAccount || ''}`;

    if (this.cache.has(cacheKey)) {
      debug('cache hit for', cacheKey);
      return this.cache.get(cacheKey)!;
    }

    const args = ['find-internet-password', '-s', server];
    if (effectiveAccount) {
      args.push('-a', effectiveAccount);
    }
    args.push('-w');
    if (this.keychainPath) {
      args.push(this.keychainPath);
    }

    try {
      debug('fetching internet password: server=%s account=%s', server, effectiveAccount || '(any)');
      const result = await spawnAsync('security', args);
      const value = result.trimEnd();
      this.cache.set(cacheKey, value);
      return value;
    } catch (err) {
      return this.handleSecurityError(err, 'internet', server, effectiveAccount);
    }
  }

  private handleSecurityError(err: unknown, type: string, service: string, account?: string): never {
    if (err instanceof ExecError) {
      const errMsg = err.data || err.message;

      // security exits 44 when item not found
      if (errMsg.includes('could not be found') || errMsg.includes('SecKeychainSearchCopyNext')) {
        const itemDesc = account ? `service="${service}", account="${account}"` : `service="${service}"`;
        throw new ResolutionError(`Keychain item not found (${itemDesc})`, {
          tip: [
            'Add it to your keychain:',
            account
              ? `  security add-generic-password -s "${service}" -a "${account}" -w "your-secret-value"`
              : `  security add-generic-password -s "${service}" -a "varlock" -w "your-secret-value"`,
            '',
            'Or use Keychain Access.app to create a new password item.',
          ].join('\n'),
        });
      }

      if (errMsg.includes('User canceled') || errMsg.includes('errSecUserCanceled')) {
        throw new ResolutionError('Keychain access was denied by user', {
          tip: 'macOS prompted for Keychain access and it was denied. Try again and allow access when prompted.',
        });
      }

      if (errMsg.includes('errSecAuthFailed')) {
        throw new ResolutionError('Keychain authentication failed', {
          tip: 'The keychain may be locked. Unlock it with: security unlock-keychain',
        });
      }

      throw new ResolutionError(`Failed to fetch ${type} password for service "${service}": ${errMsg}`);
    }

    if ((err as any).code === 'ENOENT') {
      throw new ResolutionError('`security` command not found', {
        tip: 'The `security` CLI should be available on all macOS installations. Check your PATH.',
      });
    }

    throw new ResolutionError(
      `Failed to fetch ${type} password for service "${service}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}


const pluginInstances: Record<string, KeychainPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initKeychain',
  description: 'Initialize an Apple Keychain plugin instance for keychain() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;

    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    if (objArgs?.service && !objArgs.service.isStatic) {
      throw new SchemaError('Expected service to be static');
    }
    const service = objArgs?.service ? String(objArgs.service.staticValue) : undefined;

    if (objArgs?.account && !objArgs.account.isStatic) {
      throw new SchemaError('Expected account to be static');
    }
    const account = objArgs?.account ? String(objArgs.account.staticValue) : undefined;

    if (objArgs?.keychainPath && !objArgs.keychainPath.isStatic) {
      throw new SchemaError('Expected keychainPath to be static');
    }
    const keychainPath = objArgs?.keychainPath ? String(objArgs.keychainPath.staticValue) : undefined;

    pluginInstances[id] = new KeychainPluginInstance(id);

    return {
      id, service, account, keychainPath,
    };
  },
  async execute({
    id, service, account, keychainPath,
  }) {
    pluginInstances[id].configure({ service, account, keychainPath });
  },
});


plugin.registerResolverFunction({
  name: 'keychain',
  label: 'Fetch secret from macOS Keychain',
  icon: KEYCHAIN_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 0,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId: string;
    let serviceResolver: Resolver | undefined;
    let accountResolver: Resolver | undefined;
    let inferredService: string | undefined;

    accountResolver = this.objArgs?.account;
    const typeResolver = this.objArgs?.type; // 'generic' or 'internet'

    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 0) {
      // no args: infer service name from parent config item key
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer service name - no parent config item key found', {
          tip: 'Either provide a service name as an argument, or ensure this is used within a config item',
        });
      }
      inferredService = itemKey;
    } else if (argCount === 1) {
      instanceId = '_default';
      serviceResolver = this.arrArgs![0];
    } else if (argCount === 2) {
      // 2 positional args are always (service, account) — instance id is set via the named `id` param
      instanceId = '_default';
      serviceResolver = this.arrArgs![0];
      accountResolver ||= this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 arguments');
    }

    instanceId ??= '_default';

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No keychain plugin instances found', {
        tip: 'Initialize at least one keychain plugin instance using the @initKeychain() root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Keychain plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initKeychain call',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Keychain plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return {
      instanceId, serviceResolver, accountResolver, inferredService, typeResolver,
    };
  },
  async resolve({
    instanceId, serviceResolver, accountResolver, inferredService, typeResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let service: string;
    if (serviceResolver) {
      const resolved = await serviceResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected service name to resolve to a string');
      }
      service = resolved;
    } else if (inferredService) {
      service = inferredService;
    } else {
      throw new SchemaError('No service name provided or inferred');
    }

    let account: string | undefined;
    if (accountResolver) {
      const resolved = await accountResolver.resolve();
      if (typeof resolved !== 'string') {
        throw new SchemaError('Expected account to resolve to a string');
      }
      account = resolved;
    }

    let type: 'generic' | 'internet' = 'generic';
    if (typeResolver) {
      const resolved = await typeResolver.resolve();
      if (resolved === 'internet') {
        type = 'internet';
      }
    }

    if (type === 'internet') {
      return await selectedInstance.getInternetPassword(service, account);
    }
    return await selectedInstance.getGenericPassword(service, account);
  },
});
