import { Resolver, plugin } from 'varlock/plugin-lib';
import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const PROTON_PASS_ICON = 'simple-icons:proton';

plugin.name = 'proton-pass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = PROTON_PASS_ICON;

plugin.standardVars = {
  initDecorator: '@initProtonPass',
  params: {
    password: { key: 'PROTON_PASS_PASSWORD', dataType: 'protonPassPassword' },
    totp: { key: 'PROTON_PASS_TOTP', dataType: 'protonPassTotp' },
    extraPassword: { key: 'PROTON_PASS_EXTRA_PASSWORD', dataType: 'protonPassExtraPassword' },
  },
};

const PASS_CLI_NOT_FOUND_TIP = [
  'The `pass-cli` command was not found on your system.',
  'Install it using Proton Pass CLI:',
  '  curl -fsSL https://proton.me/download/pass-cli/install.sh | bash',
].join('\n');

const NOT_LOGGED_IN_TIP = [
  'You are not authenticated with Proton Pass CLI.',
  'Either:',
  '  1) Run `pass-cli login` manually in your terminal, or',
  '  2) Configure the plugin credentials via `@initProtonPass(...)`.',
].join('\n');

const LOGIN_HELP_TIP = [
  'Proton Pass CLI login credentials are expected to be provided via:',
  '  PROTON_PASS_PASSWORD',
  '  PROTON_PASS_TOTP (if 2FA/TOTP is enabled)',
  '  PROTON_PASS_EXTRA_PASSWORD (if your account requires an extra password)',
].join('\n');

function getSecretFieldNameFromRef(secretRef: string): string | undefined {
  // secretRef is expected to be pass://<vault>/<item>/<field>
  if (!secretRef.startsWith('pass://')) return undefined;
  const remainder = secretRef.substring('pass://'.length);
  const parts = remainder.split('/');
  if (parts.length < 3) return undefined;
  return parts[parts.length - 1] || undefined;
}

function extractJsonFieldValue(
  json: unknown,
  fieldName: string,
): string | undefined {
  const visited = new Set<unknown>();

  function walk(node: unknown): unknown {
    if (node === null || node === undefined) return undefined;
    if (typeof node !== 'object') return undefined;
    if (visited.has(node)) return undefined;
    visited.add(node);

    const obj = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, fieldName)) {
      return obj[fieldName];
    }

    // Try common nested structures
    for (const key of ['fields', 'field', 'data', 'item', 'secret']) {
      if (obj[key] !== undefined) {
        const res = walk(obj[key]);
        if (res !== undefined) return res;
      }
    }

    // Fallback: try scanning one level deep for a match
    for (const val of Object.values(obj)) {
      const res = walk(val);
      if (res !== undefined) return res;
    }

    return undefined;
  }

  const match = walk(json);
  if (match === null || match === undefined) return undefined;
  if (typeof match === 'string') return match;
  if (typeof match === 'number' || typeof match === 'boolean') return String(match);
  return undefined;
}

class ProtonPassPluginInstance {
  private username?: string;
  private password?: string;
  private totp?: string;
  private extraPassword?: string;

  // Cache decrypted values for the current resolution session.
  private cache = new Map<string, string>();

  // Login batching / deduping for parallel resolutions.
  private loginInFlight: Promise<void> | undefined;

  private loggedInAtMs?: number;
  private loggedInTtlMs = 60_000;

  constructor(readonly id: string) {}

  configure(opts: {
    username?: string;
    password?: string;
    totp?: string;
    extraPassword?: string;
  }) {
    if (opts.username && typeof opts.username === 'string') this.username = opts.username;
    if (opts.password && typeof opts.password === 'string') this.password = opts.password;
    if (opts.totp && typeof opts.totp === 'string') this.totp = opts.totp;
    if (opts.extraPassword && typeof opts.extraPassword === 'string') this.extraPassword = opts.extraPassword;

    debug('proton-pass instance', this.id, 'configured');
  }

  private get loginEnv(): Record<string, string> | undefined {
    const env: Record<string, string> = {};
    if (this.password) env.PROTON_PASS_PASSWORD = this.password;
    if (this.totp) env.PROTON_PASS_TOTP = this.totp;
    if (this.extraPassword) env.PROTON_PASS_EXTRA_PASSWORD = this.extraPassword;

    return Object.keys(env).length ? env : undefined;
  }

  private async ensureCliLoggedIn(): Promise<void> {
    // fast path: info is assumed ok for a short time window
    if (this.loggedInAtMs && Date.now() - this.loggedInAtMs < this.loggedInTtlMs) return;

    if (this.loginInFlight) {
      await this.loginInFlight;
      return;
    }

    this.loginInFlight = (async () => {
      try {
        debug('checking proton pass login via `pass-cli info`');
        await spawnAsync('pass-cli', ['info']);
        this.loggedInAtMs = Date.now();
        return;
      } catch (err) {
        // fall through to login attempt
        const errMsg = err instanceof ExecError ? (err.data || err.message) : String(err);
        debug('pass-cli info failed:', errMsg);

        if (err instanceof ExecError && (err as any).code === 'ENOENT') {
          throw new ResolutionError('`pass-cli` command not found', {
            tip: PASS_CLI_NOT_FOUND_TIP,
          });
        }

        const needsLogin = [
          'not logged',
          'not authenticated',
          'unauthorized',
          'login required',
          'authentication',
          'session',
        ].some((t) => errMsg.toLowerCase().includes(t));

        if (!needsLogin) {
          throw new ResolutionError(`Proton Pass CLI error: ${errMsg}`, {
            tip: ['Try running `pass-cli info` to inspect the CLI state.'].join('\n'),
          });
        }

        // Attempt login
        if (!this.username) {
          throw new ResolutionError('Proton Pass CLI not authenticated and no username configured', {
            tip: [
              NOT_LOGGED_IN_TIP,
              'Initialize the plugin with a username: @initProtonPass(username=..., ...)',
            ].join('\n'),
          });
        }

        if (!this.password) {
          throw new ResolutionError('Proton Pass CLI not authenticated and no password configured', {
            tip: [
              NOT_LOGGED_IN_TIP,
              LOGIN_HELP_TIP,
              'Provide `password` via `@initProtonPass(password=...)` or set `PROTON_PASS_PASSWORD`.',
            ].join('\n'),
          });
        }

        debug('logging into proton pass via `pass-cli login --interactive`');
        try {
          await spawnAsync(
            'pass-cli',
            ['login', '--interactive', this.username],
            this.loginEnv ? { env: { ...(process.env as Record<string, string>), ...this.loginEnv } } : undefined,
          );
        } catch (loginErr) {
          const loginMsg = loginErr instanceof ExecError ? (loginErr.data || loginErr.message) : String(loginErr);
          throw new ResolutionError(`Proton Pass CLI login failed: ${loginMsg}`, {
            tip: [
              NOT_LOGGED_IN_TIP,
              LOGIN_HELP_TIP,
            ].join('\n'),
          });
        }

        // Verify after login
        await spawnAsync('pass-cli', ['info']);
        this.loggedInAtMs = Date.now();
      }
    })();

    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = undefined;
    }
  }

  async getSecret(secretRef: string): Promise<string> {
    const cached = this.cache.get(secretRef);
    if (cached !== undefined) return cached;

    await this.ensureCliLoggedIn();

    const fieldName = getSecretFieldNameFromRef(secretRef);
    if (!fieldName) {
      throw new ResolutionError(`Invalid secret reference (missing field): ${secretRef}`);
    }

    debug('fetching proton pass secret via item view', secretRef);
    const result = await spawnAsync(
      'pass-cli',
      ['item', 'view', '--output', 'json', secretRef],
    );
    const cliStdout = result.trim();

    // Parse JSON output as best-effort.
    try {
      const parsed = JSON.parse(cliStdout);
      const extracted = extractJsonFieldValue(parsed, fieldName);
      if (extracted === undefined) {
        // If `pass-cli` printed just the field value, fall back to stringification.
        if (typeof parsed === 'string') return parsed;
        throw new ResolutionError(
          `Proton Pass field "${fieldName}" not found in CLI output`,
          { tip: 'Try running the equivalent command manually to inspect the output shape.' },
        );
      }
      this.cache.set(secretRef, extracted);
      return extracted;
    } catch (e) {
      // Not JSON? Fall back to returning stdout.
      const plain = cliStdout.trim();
      if (!plain) {
        throw new ResolutionError(`Proton Pass secret "${secretRef}" resolved to empty output`);
      }
      this.cache.set(secretRef, plain);
      return plain;
    }
  }
}

const pluginInstances: Record<string, ProtonPassPluginInstance> = {};

plugin.registerDataType({
  name: 'protonPassSecretRef',
  sensitive: false,
  typeDescription: 'Proton Pass secret reference in the format `pass://vault/item/field`',
  icon: PROTON_PASS_ICON,
  docs: [
    {
      description: 'Secret reference syntax for Proton Pass CLI',
      url: 'https://protonpass.github.io/pass-cli/commands/contents/secret-references/',
    },
  ],
  async validate(val) {
    if (typeof val !== 'string') throw new ValidationError('Secret reference must be a string');
    if (!val.startsWith('pass://')) throw new ValidationError('Secret reference must start with `pass://`');

    const remainder = val.substring('pass://'.length);
    const parts = remainder.split('/');
    if (parts.length !== 3 || parts.some((p) => !p.trim())) {
      throw new ValidationError('Secret reference must be in format `pass://<vault>/<item>/<field>` (exactly 3 components)');
    }
  },
});

plugin.registerDataType({
  name: 'protonPassPassword',
  sensitive: true,
  typeDescription: 'Proton Pass account password used by `pass-cli login --interactive`',
  icon: PROTON_PASS_ICON,
  docs: [
    {
      description: 'Proton Pass CLI login',
      url: 'https://protonpass.github.io/pass-cli/commands/login/',
    },
  ],
  async validate(val): Promise<true> {
    if (!val || typeof val !== 'string') throw new ValidationError('Password must be a non-empty string');
    return true;
  },
});

plugin.registerDataType({
  name: 'protonPassTotp',
  sensitive: true,
  typeDescription: 'Proton Pass TOTP code used by `pass-cli login --interactive` (if 2FA is enabled)',
  icon: PROTON_PASS_ICON,
  async validate(val): Promise<true> {
    if (!val || typeof val !== 'string') throw new ValidationError('TOTP must be a non-empty string');
    if (!/^[0-9]{6,8}$/.test(val.trim())) throw new ValidationError('TOTP should be 6-8 digits');
    return true;
  },
});

plugin.registerDataType({
  name: 'protonPassExtraPassword',
  sensitive: true,
  typeDescription: 'Proton Pass extra password used by `pass-cli login --interactive` (if required by your account)',
  icon: PROTON_PASS_ICON,
  async validate(val): Promise<true> {
    if (!val || typeof val !== 'string') throw new ValidationError('Extra password must be a non-empty string');
    return true;
  },
});

plugin.registerRootDecorator({
  name: 'initProtonPass',
  description: 'Initialize a Proton Pass plugin instance for protonPass() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    // Allow `@initProtonPass()` with no key-value args (same pattern as `@initPass()`):
    // default instance id is `_default` and credentials are optional if `pass-cli` is already logged in.

    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be a static value');
    }
    const id = String(objArgs?.id?.staticValue || '_default');

    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    pluginInstances[id] = new ProtonPassPluginInstance(id);

    // These are resolver children - they may be computed from env flags.
    return {
      id,
      usernameResolver: objArgs?.username,
      passwordResolver: objArgs?.password,
      totpResolver: objArgs?.totp,
      extraPasswordResolver: objArgs?.extraPassword,
    };
  },
  async execute({
    id, usernameResolver, passwordResolver, totpResolver, extraPasswordResolver,
  }) {
    const username = await usernameResolver?.resolve();
    const password = await passwordResolver?.resolve();
    const totp = await totpResolver?.resolve();
    const extraPassword = await extraPasswordResolver?.resolve();

    pluginInstances[id].configure({
      username: typeof username === 'string' ? username : undefined,
      password: typeof password === 'string' ? password : undefined,
      totp: typeof totp === 'string' ? totp : undefined,
      extraPassword: typeof extraPassword === 'string' ? extraPassword : undefined,
    });
  },
});

plugin.registerResolverFunction({
  name: 'protonPass',
  label: 'Fetch secret from Proton Pass',
  icon: PROTON_PASS_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let secretRefResolver: Resolver | undefined;
    const allowMissingResolver = this.objArgs?.allowMissing;

    if (!this.arrArgs) throw new SchemaError('Expected args');
    const argCount = this.arrArgs.length;

    if (argCount === 1) {
      secretRefResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      if (!this.arrArgs[0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs[0].staticValue);
      secretRefResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 1 or 2 arguments');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No Proton Pass plugin instances found', {
        tip: 'Initialize at least one Proton Pass plugin instance using the @initProtonPass root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('Proton Pass plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initProtonPass call',
            'or use `protonPass(id, secretRef)` to select an instance by id',
            `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Proton Pass plugin instance id "${instanceId}" not found`, {
          tip: `Valid ids are: ${Object.keys(pluginInstances).join(', ')}`,
        });
      }
    }

    return { instanceId, secretRefResolver, allowMissingResolver };
  },
  async resolve({ instanceId, secretRefResolver, allowMissingResolver }) {
    const selectedInstance = pluginInstances[instanceId];

    if (!secretRefResolver) {
      throw new SchemaError('Expected a Proton Pass secret reference argument');
    }
    const secretRef = await secretRefResolver.resolve();
    if (typeof secretRef !== 'string') {
      throw new SchemaError('Expected secretRef to resolve to a string');
    }

    let allowMissing = false;
    if (allowMissingResolver) {
      const resolved = await allowMissingResolver.resolve();
      allowMissing = resolved === true || resolved === 'true';
    }

    try {
      return await selectedInstance.getSecret(secretRef);
    } catch (err) {
      if (allowMissing) {
        if (err instanceof ExecError) {
          const msg = err.data || err.message;
          if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('field not found')) return '';
        }
        if (err instanceof ResolutionError && err.message.toLowerCase().includes('not found')) return '';
      }

      if (err instanceof ExecError && (err as any).code === 'ENOENT') {
        throw new ResolutionError('`pass-cli` command not found', { tip: PASS_CLI_NOT_FOUND_TIP });
      }

      if (err instanceof ExecError) {
        const errMsg = err.data || err.message;
        const lower = errMsg.toLowerCase();
        if (lower.includes('not logged') || lower.includes('not authenticated') || lower.includes('unauthorized') || lower.includes('login')) {
          throw new ResolutionError('Proton Pass CLI not authenticated', { tip: NOT_LOGGED_IN_TIP });
        }

        if (lower.includes('not found')) {
          throw new ResolutionError('Proton Pass secret not found', {
            tip: [
              'Verify your `pass://vault/item/field` reference is correct:',
              '  - pass-cli vault list',
              '  - pass-cli item list --share-id <vault-share-id>',
              '  - pass-cli item view --share-id <share-id> --item-id <item-id>',
            ].join('\n'),
          });
        }

        throw new ResolutionError(`Failed to fetch Proton Pass secret: ${errMsg}`);
      }

      if (err instanceof ResolutionError) throw err;
      throw new ResolutionError(`Failed to fetch Proton Pass secret: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});


