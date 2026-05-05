import { type Resolver, plugin } from 'varlock/plugin-lib';

import { createDeferredPromise, type DeferredPromise } from '@env-spec/utils/defer';
import { spawnAsync } from '@env-spec/utils/exec-helpers';
import { Client, createClient } from '@1password/sdk';
import {
  opCliEnvironmentRead, processOpCliError, pickProxyEnv,
} from './cli-helper';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;
const { debug } = plugin;

const PLUGIN_VERSION = plugin.version;
const OP_ICON = 'simple-icons:1password';

/** Called after each `op` invocation so parallel waiters can proceed; no-op when this caller only waited on the mutex. */
type OpAuthCompletedFn = (success: boolean) => void;

const CLI_BATCH_READ_TIMEOUT = 50;

/*
  ! IMPORTANT INFO ON CLI APP AUTH

  Because we trigger multiple requests in parallel, if the app/cli is not unlocked, it will show multiple auth popups.
  In a big project this is super awkward because you may need to scan your finger over and over again.

  To work around this, we track if we are currently making the first op cli command, and if so acquire a mutex in the form of
  a deferred promise that other requests can then wait on. We also use the additional trick of checking `op whoami` so that
  if the app is already unlocked, we dont have to actually wait for the first request to finish to proceed with the rest.

  Ideally 1Password will fix this issue at some point and we can remove this extra logic.

  NOTE - We don't currently do anything special to handle if the user denies the login, or is logged into the wrong account.

  IMPORTANT: This shared state is intentional for the `allowAppAuth` path. When authenticating via the local 1Password
  desktop app (not a service account), all plugin instances share the same local login context, so we must use a single
  shared auth mutex to prevent duplicate auth prompts. Service account instances use per-instance state instead.
*/

// Module-level auth mutex shared across all allowAppAuth instances (same local `op` login context).
let appAuthDeferred: DeferredPromise<boolean> | undefined;
// Module-level read batch shared across all allowAppAuth instances.
let appAuthBatch: Record<string, { deferredPromises: Array<DeferredPromise<string>> }> | undefined;
// Locked account for the shared app auth path (all app-auth instances must use the same account).
let lockCliToOpAccount: string | undefined;

async function checkAppCliAuth(): Promise<OpAuthCompletedFn> {
  if (appAuthDeferred) {
    await appAuthDeferred.promise;
    return () => undefined;
  }
  appAuthDeferred = createDeferredPromise<boolean>();
  return appAuthDeferred.resolve;
}

async function executeAppCliBatch(batchToExecute: NonNullable<typeof appAuthBatch>) {
  debug('execute op read batch (app auth)', Object.keys(batchToExecute));
  const envMap = {} as Record<string, string>;
  let i = 1;
  Object.keys(batchToExecute).forEach((opReference) => {
    envMap[`VARLOCK_1P_INJECT_${i++}`] = opReference;
  });
  const startAt = new Date();

  const authCompletedFn = await checkAppCliAuth();
  // `env -0` splits values by a null character instead of newlines
  // because otherwise we'll have trouble dealing with values that contain newlines
  await spawnAsync('op', `run --no-masking ${lockCliToOpAccount ? `--account ${lockCliToOpAccount} ` : ''}-- env -0`.split(' '), {
    env: {
      PATH: process.env.PATH!,
      ...process.env.USER && { USER: process.env.USER },
      ...process.env.HOME && { HOME: process.env.HOME },
      ...process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
      ...pickProxyEnv(),
      OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
      ...envMap,
    },
  })
    .then((result) => {
      authCompletedFn?.(true);
      debug(`batched OP request took ${+new Date() - +startAt}ms`);

      const lines = result.split('\0');
      for (const line of lines) {
        const eqPos = line.indexOf('=');
        const key = line.substring(0, eqPos);
        if (!envMap[key]) continue;
        const val = line.substring(eqPos + 1);
        const opRef = envMap[key];
        batchToExecute[opRef].deferredPromises.forEach((p) => {
          p.resolve(val);
        });
      }
    })
    .catch(async (err) => {
      authCompletedFn?.(false);
      const opErr = processOpCliError(err);
      debug('batch failed', opErr);
      if ((opErr as any).code === 'BAD_VAULT_REFERENCE') {
        const badId = (opErr as any).extraMetadata.badVaultId;
        for (const opRef in batchToExecute) {
          if (opRef.startsWith(`op://${badId}/`)) {
            batchToExecute[opRef].deferredPromises.forEach((p) => {
              p.reject(opErr);
            });
            delete batchToExecute[opRef];
          }
        }
      } else if ((opErr as any).code === 'BAD_ITEM_REFERENCE') {
        const badId = (opErr as any).extraMetadata.badItemId;
        for (const opRef in batchToExecute) {
          if (opRef.split('/')?.[3] === badId) {
            batchToExecute[opRef].deferredPromises.forEach((p) => {
              p.reject(opErr);
            });
            delete batchToExecute[opRef];
          }
        }
      } else if ((opErr as any).code === 'BAD_FIELD_REFERENCE') {
        const badId = (opErr as any).extraMetadata.badFieldId;
        for (const opRef in batchToExecute) {
          if (opRef.split('/')?.slice(4).join('/') === badId) {
            batchToExecute[opRef].deferredPromises.forEach((p) => {
              p.reject(opErr);
            });
            delete batchToExecute[opRef];
          }
        }
      } else {
        for (const opRef in batchToExecute) {
          batchToExecute[opRef].deferredPromises.forEach((p) => {
            p.reject(opErr);
          });
          delete batchToExecute[opRef];
        }
      }
      if (Object.keys(batchToExecute).length) {
        debug('re-executing remainder of batch', Object.keys(batchToExecute));
        await executeAppCliBatch(batchToExecute);
      }
    });
}

/**
 * Reads a 1Password reference via the CLI + desktop app auth path.
 * Uses a module-level shared batch and auth mutex since all allowAppAuth instances
 * share the same local `op` login context.
 */
async function appAuthCliRead(opReference: string, account?: string): Promise<string> {
  lockCliToOpAccount ||= account;
  if (account && lockCliToOpAccount !== account) {
    throw new ResolutionError('Cannot use multiple different 1Password accounts when using CLI auth with batching enabled', {
      tip: [
        'When using CLI auth with batching, all references must use the same 1Password account',
        'Consider using service account tokens instead of CLI auth to allow multiple accounts',
      ],
    });
  }

  let shouldExecuteBatch = false;
  if (!appAuthBatch) {
    appAuthBatch = {};
    shouldExecuteBatch = true;
  }
  appAuthBatch[opReference] ||= { deferredPromises: [] };
  const deferred = createDeferredPromise<string>();
  appAuthBatch[opReference].deferredPromises.push(deferred);
  if (shouldExecuteBatch) {
    setTimeout(async () => {
      if (!appAuthBatch) throw Error('Internal error: app-auth CLI batch was unexpectedly cleared before execution');
      const batchToExecute = appAuthBatch;
      appAuthBatch = undefined;
      await executeAppCliBatch(batchToExecute);
    }, CLI_BATCH_READ_TIMEOUT);
  }
  return deferred.promise;
}

plugin.name = '1pass';
debug('init - version =', plugin.version);
plugin.icon = OP_ICON;
plugin.standardVars = {
  initDecorator: '@initOp',
  params: {
    token: { key: ['OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_TOKEN'] },
  },
};

// ──────────────────────────────────────────────────────────────
// 1Password Connect Server helpers (direct REST API via fetch)
// ──────────────────────────────────────────────────────────────

interface ConnectField {
  id: string;
  label?: string;
  value?: string;
  type?: string;
  purpose?: string;
  section?: { id: string };
}

interface ConnectSection {
  id: string;
  label?: string;
}

interface ConnectItem {
  id: string;
  title?: string;
  fields?: Array<ConnectField>;
  sections?: Array<ConnectSection>;
}

interface ConnectVault {
  id: string;
  name?: string;
}

/** Parse an `op://vault/item/[section/]field` reference into its parts */
function parseOpReference(ref: string): {
  vault: string; item: string; section?: string; field: string;
} {
  const stripped = ref.replace(/^op:\/\//, '');
  const parts = stripped.split('/');
  if (parts.length === 3) {
    return { vault: parts[0], item: parts[1], field: parts[2] };
  } else if (parts.length === 4) {
    return {
      vault: parts[0], item: parts[1], section: parts[2], field: parts[3],
    };
  }
  throw new ResolutionError(`Invalid op:// reference format: "${ref}"`, {
    tip: 'Expected format: op://vault/item/field or op://vault/item/section/field',
  });
}

/** Parse env format output from `op environment read` into a flat {name: value} JSON string */
function parseOpEnvOutput(raw: string): string {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eqPos = line.indexOf('=');
    if (eqPos === -1) continue;
    const key = line.substring(0, eqPos).trim();
    if (!key) continue;
    result[key] = line.substring(eqPos + 1);
  }
  return JSON.stringify(result);
}

class OpPluginInstance {
  /** 1Password service account token */
  private token?: string;
  /** optional - account shorthand or id to limit access */
  private account?: string;
  /**
   * if true, will try to use 1Pass app auth (via `op` CLI)
   * (will not be set to true if a token is provided)
   * */
  private allowAppAuth?: boolean;
  /**
   * if true, use the `op` CLI with the service account token instead of the WASM SDK.
   * Useful in memory-constrained environments where the SDK is too heavy.
   * */
  private useCliWithServiceAccount?: boolean;
  /** URL of a 1Password Connect server */
  private connectHost?: string;
  /** API token for authenticating with the Connect server */
  private connectToken?: string;
  /** If true, missing items/fields/vaults return undefined instead of throwing */
  allowMissing?: boolean;

  /** Per-instance auth mutex for the service-account CLI path (each token is an independent auth context). */
  private cliAuthDeferred?: DeferredPromise<boolean>;
  /** Per-instance CLI read batch for the service-account CLI path. */
  private cliBatch?: Record<string, { deferredPromises: Array<DeferredPromise<string>> }>;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(
    token: any,
    allowAppAuth: boolean,
    account?: string,
    connectHost?: string,
    connectToken?: string,
    allowMissing?: boolean,
    useCliWithServiceAccount?: boolean,
  ) {
    if (token && typeof token === 'string') this.token = token;
    this.allowAppAuth = allowAppAuth;
    this.useCliWithServiceAccount = useCliWithServiceAccount;
    this.account = account;
    if (connectHost && typeof connectHost === 'string') this.connectHost = connectHost.replace(/\/+$/, '');
    if (connectToken && typeof connectToken === 'string') this.connectToken = connectToken;
    if (allowMissing !== undefined) this.allowMissing = allowMissing;
    debug('op instance', this.id, ' set auth - ', token, allowAppAuth, account, 'connect:', !!connectHost, 'useCliWithServiceAccount:', useCliWithServiceAccount);
  }

  /** Whether this instance is configured for Connect server */
  get isConnect() { return !!(this.connectHost && this.connectToken); }

  opClientPromise: Promise<Client> | undefined;
  async initSdkClient() {
    if (!this.token) return;
    if (this.opClientPromise) return;

    // TODO: pass through account once SDK allows it
    this.opClientPromise = createClient({
      auth: this.token,
      integrationName: 'varlock plugin',
      integrationVersion: PLUGIN_VERSION,
    });
  }

  // ── Connect REST API helpers ──────────────────────────────

  // ── CLI helpers (per-instance, for service account path only) ──────

  private async checkCliAuth(): Promise<OpAuthCompletedFn> {
    if (this.cliAuthDeferred) {
      // Wait for the in-flight first `op` call to finish (or an earlier batch to settle the mutex).
      await this.cliAuthDeferred.promise;
      // Mutex is already resolved — still return a callable so callers can always invoke authCompletedFn(success).
      return () => undefined;
    }
    // First caller creates the mutex and must call the returned fn when its `op` run completes.
    this.cliAuthDeferred = createDeferredPromise<boolean>();
    return this.cliAuthDeferred.resolve;
  }

  /** Executes the per-instance CLI read batch using `op run` with a service account token. */
  private async executeCliBatch(batchToExecute: NonNullable<typeof this.cliBatch>) {
    debug('execute op read batch', Object.keys(batchToExecute));
    const envMap = {} as Record<string, string>;
    let i = 1;
    Object.keys(batchToExecute).forEach((opReference) => {
      envMap[`VARLOCK_1P_INJECT_${i++}`] = opReference;
    });
    const startAt = new Date();

    const authCompletedFn = await this.checkCliAuth();
    // `env -0` splits values by a null character instead of newlines
    // because otherwise we'll have trouble dealing with values that contain newlines
    await spawnAsync('op', `run --no-masking ${this.account ? `--account ${this.account} ` : ''}-- env -0`.split(' '), {
      env: {
        // have to pass a few things through at least path so it can find `op` and related config files
        PATH: process.env.PATH!,
        ...process.env.USER && { USER: process.env.USER },
        ...process.env.HOME && { HOME: process.env.HOME },
        ...process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
        // proxy env vars so `op` can connect through HTTP/SOCKS proxies
        ...pickProxyEnv(),
        // forward service account token when the instance opted into CLI-based service account auth
        ...this.useCliWithServiceAccount && this.token && { OP_SERVICE_ACCOUNT_TOKEN: this.token },
        // this setting actually just enables the CLI + Desktop App integration
        // which in some cases op has a hard time detecting via app setting
        OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
        ...envMap,
      },
    })
      .then(async (result) => {
        authCompletedFn?.(true);
        debug(`batched OP request took ${+new Date() - +startAt}ms`);

        const lines = result.split('\0');
        for (const line of lines) {
          const eqPos = line.indexOf('=');
          const key = line.substring(0, eqPos);

          if (!envMap[key]) continue;
          const val = line.substring(eqPos + 1);
          const opRef = envMap[key];

          // resolve the deferred promises with the value
          batchToExecute[opRef].deferredPromises.forEach((p) => {
            p.resolve(val);
          });
        }
      })
      .catch(async (err) => {
        authCompletedFn?.(false);

        // have to do special handling of errors because if any IDs are no good, it kills the whole request
        const opErr = processOpCliError(err);
        debug('batch failed', opErr);
        if ((opErr as any).code === 'BAD_VAULT_REFERENCE') {
          const badId = (opErr as any).extraMetadata.badVaultId;
          debug('skipping failed bad vault id -', badId);
          for (const opRef in batchToExecute) {
            if (opRef.startsWith(`op://${badId}/`)) {
              batchToExecute[opRef].deferredPromises.forEach((p) => {
                p.reject(opErr);
              });
              delete batchToExecute[opRef];
            }
          }
        } else if ((opErr as any).code === 'BAD_ITEM_REFERENCE') {
          const badId = (opErr as any).extraMetadata.badItemId;
          debug('skipping failed bad item id -', badId);
          for (const opRef in batchToExecute) {
            const itemRef = opRef.split('/')?.[3];
            if (itemRef === badId) {
              batchToExecute[opRef].deferredPromises.forEach((p) => {
                p.reject(opErr);
              });
              delete batchToExecute[opRef];
            }
          }
        } else if ((opErr as any).code === 'BAD_FIELD_REFERENCE') {
          const badId = (opErr as any).extraMetadata.badFieldId;
          debug('skipping failed bad field id -', badId);
          for (const opRef in batchToExecute) {
            const fieldRef = opRef.split('/')?.slice(4).join('/');
            if (fieldRef === badId) {
              batchToExecute[opRef].deferredPromises.forEach((p) => {
                p.reject(opErr);
              });
              delete batchToExecute[opRef];
            }
          }
        } else {
          for (const opRef in batchToExecute) {
            batchToExecute[opRef].deferredPromises.forEach((p) => {
              p.reject(opErr);
            });
            delete batchToExecute[opRef];
          }
        }

        if (Object.keys(batchToExecute).length) {
          debug('re-executing remainder of batch', Object.keys(batchToExecute));
          await this.executeCliBatch(batchToExecute);
        }
      });
  }

  /**
   * Reads a single value from 1Password by reference (similar to `op read`)
   * but internally batches requests per-instance using `op run`.
   */
  private async cliRead(opReference: string): Promise<string> {
    // if no batch exists, we'll create it, and this function will kick it off after a timeout
    let shouldExecuteBatch = false;
    if (!this.cliBatch) {
      this.cliBatch = {};
      shouldExecuteBatch = true;
    }

    // otherwise we'll just add to the existing batch
    this.cliBatch[opReference] ||= { deferredPromises: [] };

    const deferred = createDeferredPromise<string>();
    this.cliBatch[opReference].deferredPromises.push(deferred);

    if (shouldExecuteBatch) {
      setTimeout(async () => {
        if (!this.cliBatch) throw Error('Internal error: CLI batch was unexpectedly cleared before execution');
        const batchToExecute = this.cliBatch;
        this.cliBatch = undefined;
        await this.executeCliBatch(batchToExecute);
      }, CLI_BATCH_READ_TIMEOUT);
    }
    return deferred.promise;
  }

  // ── Connect REST API helpers ──────────────────────────────

  private async connectRequest<T>(path: string): Promise<T> {
    const url = `${this.connectHost}/v1${path}`;
    debug('connect request:', url);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.connectToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ResolutionError(`1Password Connect API error (${res.status}): ${body || res.statusText}`, {
        tip: [
          `Request: GET ${path}`,
          'Verify your Connect server URL and token are correct',
          'Check that the Connect server is running and reachable',
        ],
      });
    }
    return res.json() as Promise<T>;
  }

  /** Cache vault name → ID lookups within a session (Connect only) */
  private connectVaultIdCache = new Map<string, string>();

  private async connectResolveVaultId(vaultQuery: string): Promise<string> {
    if (this.connectVaultIdCache.has(vaultQuery)) return this.connectVaultIdCache.get(vaultQuery)!;

    // Try direct ID lookup first
    try {
      const vault = await this.connectRequest<ConnectVault>(`/vaults/${encodeURIComponent(vaultQuery)}`);
      this.connectVaultIdCache.set(vaultQuery, vault.id);
      return vault.id;
    } catch {
      // fall through to title search
    }

    // Search by title (escape backslashes then quotes for the filter expression)
    const escapedVault = vaultQuery.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const vaults = await this.connectRequest<Array<ConnectVault>>(
      `/vaults?filter=${encodeURIComponent(`name eq "${escapedVault}"`)}`,
    );
    if (!vaults.length) {
      throw new ResolutionError(`1Password Connect: vault "${vaultQuery}" not found`, {
        code: 'NOT_FOUND',
        tip: 'Check the vault name or ID in your op:// reference',
      });
    }
    this.connectVaultIdCache.set(vaultQuery, vaults[0].id);
    return vaults[0].id;
  }

  /** Cache item title → ID lookups within a session (Connect only) */
  private connectItemIdCache = new Map<string, string>();

  private async connectResolveItemId(vaultId: string, itemQuery: string): Promise<string> {
    const cacheKey = `${vaultId}/${itemQuery}`;
    if (this.connectItemIdCache.has(cacheKey)) return this.connectItemIdCache.get(cacheKey)!;

    // Try direct ID lookup first
    try {
      const item = await this.connectRequest<ConnectItem>(`/vaults/${vaultId}/items/${encodeURIComponent(itemQuery)}`);
      this.connectItemIdCache.set(cacheKey, item.id);
      return item.id;
    } catch {
      // fall through to title search
    }

    // Search by title (escape backslashes then quotes for the filter expression)
    const escapedItem = itemQuery.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const items = await this.connectRequest<Array<{ id: string; title?: string }>>(
      `/vaults/${vaultId}/items?filter=${encodeURIComponent(`title eq "${escapedItem}"`)}`,
    );
    if (!items.length) {
      throw new ResolutionError(`1Password Connect: item "${itemQuery}" not found in vault`, {
        code: 'NOT_FOUND',
        tip: 'Check the item name or ID in your op:// reference',
      });
    }
    this.connectItemIdCache.set(cacheKey, items[0].id);
    return items[0].id;
  }

  private connectExtractField(item: ConnectItem, sectionQuery: string | undefined, fieldQuery: string): string {
    const fields = item.fields || [];
    const sections = item.sections || [];

    let sectionId: string | undefined;
    if (sectionQuery) {
      const section = sections.find(
        (s) => s.id === sectionQuery || s.label?.toLowerCase() === sectionQuery.toLowerCase(),
      );
      if (!section) {
        throw new ResolutionError(
          `1Password Connect: section "${sectionQuery}" not found in item "${item.title || item.id}"`,
          { code: 'NOT_FOUND', tip: `Available sections: ${sections.map((s) => s.label || s.id).join(', ') || '(none)'}` },
        );
      }
      sectionId = section.id;
    }

    const candidates = sectionId
      ? fields.filter((f) => f.section?.id === sectionId)
      : fields;

    const field = candidates.find(
      (f) => f.id === fieldQuery
        || f.label?.toLowerCase() === fieldQuery.toLowerCase(),
    );

    if (!field) {
      throw new ResolutionError(
        `1Password Connect: field "${fieldQuery}" not found in item "${item.title || item.id}"`,
        { code: 'NOT_FOUND', tip: `Available fields: ${candidates.map((f) => f.label || f.id).join(', ') || '(none)'}` },
      );
    }

    return field.value ?? '';
  }

  private async readItemViaConnect(opReference: string): Promise<string> {
    const parsed = parseOpReference(opReference);
    const vaultId = await this.connectResolveVaultId(parsed.vault);
    const itemId = await this.connectResolveItemId(vaultId, parsed.item);
    const fullItem = await this.connectRequest<ConnectItem>(`/vaults/${vaultId}/items/${itemId}`);
    return this.connectExtractField(fullItem, parsed.section, parsed.field);
  }

  // ── Core read methods ─────────────────────────────────────

  readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

  async readItem(opReference: string) {
    if (this.isConnect) {
      return await this.readItemViaConnect(opReference);
    } else if (this.token && this.useCliWithServiceAccount) {
      // user wants to use the `op` CLI with service account token instead of the WASM SDK
      return await this.cliRead(opReference);
    } else if (this.token) {
      // using JS SDK client using service account token
      await this.initSdkClient();
      if (this.opClientPromise) {
        // simple batching setup, so we can use bulk read sdk method
        let triggerBatch = false;
        if (!this.readBatch) {
          this.readBatch = {};
          triggerBatch = true;
        }
        // add item to batch, with deferred promise
        this.readBatch[opReference] ||= { defers: [] };
        const deferred = createDeferredPromise<string>();
        this.readBatch[opReference].defers.push(deferred);
        if (triggerBatch) {
          setImmediate(() => this.executeReadBatch());
        }
        return deferred.promise;
      }
    } else if (this.allowAppAuth) {
      // using op CLI to talk to 1Password desktop app
      // Uses shared module-level batch+mutex since all app-auth instances share the same local `op` login context.
      return await appAuthCliRead(opReference, this.account);
    } else {
      throw new SchemaError('Unable to authenticate with 1Password', {
        tip: `Plugin instance (${this.id}) must be provided a service account token, a Connect server, or have app auth enabled (allowAppAuth=true)`,
      });
    }
  }

  async readEnvironment(environmentId: string): Promise<string> {
    if (this.isConnect) {
      throw new ResolutionError('1Password Environments are not supported with Connect server', {
        tip: [
          'The 1Password Connect server API does not support the Environments feature.',
          'Use a service account token or desktop app auth instead, or use op() to read individual items.',
        ],
      });
    } else if (this.token && this.useCliWithServiceAccount) {
      // user wants to use the `op` CLI with service account token instead of the WASM SDK
      const cliResult = await opCliEnvironmentRead(environmentId, this.account, this.token);
      return parseOpEnvOutput(cliResult);
    } else if (this.token) {
      // Use SDK - supports environments since v0.4.1-beta.1
      await this.initSdkClient();
      const opClient = await this.opClientPromise;
      if (!opClient) throw new Error('Expected op sdk to be initialized');
      const response = await opClient.environments.getVariables(environmentId);
      // Convert EnvironmentVariable[] to flat {name: value} JSON string
      const result: Record<string, string> = {};
      for (const v of response.variables) {
        result[v.name] = v.value;
      }
      return JSON.stringify(result);
    } else if (this.allowAppAuth) {
      // Use CLI for desktop app auth
      const cliResult = await opCliEnvironmentRead(environmentId, this.account);
      // CLI outputs env format (KEY=value lines) - parse to flat JSON
      return parseOpEnvOutput(cliResult);
    } else {
      throw new SchemaError('Unable to authenticate with 1Password', {
        tip: `Plugin instance (${this.id}) must be provided a service account token, a Connect server, or have app auth enabled (allowAppAuth=true)`,
      });
    }
  }

  private async executeReadBatch() {
    const opClient = await this.opClientPromise;
    if (!opClient) throw new Error('Expected op sdk to be initialized');

    const batch = this.readBatch;
    this.readBatch = undefined;

    const opReferences = Object.keys(batch || {});
    debug('bulk fetching', opReferences);
    if (!opReferences.length) return;

    try {
      const result = await opClient.secrets.resolveAll(opReferences);

      for (const ref in batch) {
        const itemResponse = result.individualResponses[ref];
        for (const dp of batch[ref].defers) {
          if (!itemResponse) {
            dp.reject(new ResolutionError(`1Password error - no response returned for reference: ${ref}`));
          } else if (itemResponse.error) {
            const errMsg = itemResponse.error.message || itemResponse.error.type || '';
            const isNotFound = /not.?found|does.?not.?exist|no.?such/i.test(errMsg);
            dp.reject(new ResolutionError(`1Password error - ${errMsg}`, {
              ...(isNotFound ? { code: 'NOT_FOUND' } : {}),
            }));
          } else if (itemResponse.content) {
            dp.resolve(itemResponse.content.secret);
          } else {
            dp.reject(new ResolutionError('bulk fetch is missing item response'));
          }
        }
      }
    } catch (err) {
      let commonErr;
      // 1pass sdk throws strings as errors...
      if (typeof err === 'string') {
        commonErr = new ResolutionError(`1Password SDK error - ${err}`);
      } else {
        commonErr = err as Error;
      }

      for (const ref in batch) {
        for (const dp of batch[ref].defers) {
          const wrappedErr = new ResolutionError(`1Password error - ${commonErr.message}`);
          (wrappedErr as any).cause = commonErr;
          dp.reject(wrappedErr);
        }
      }
    }
  }
}
const pluginInstances: Record<string, OpPluginInstance> = {};

/** Returns true if the error represents a missing 1Password item/field/vault */
function isNotFoundError(err: any): boolean {
  const code = err?.code;
  return code === 'NOT_FOUND'
    || code === 'BAD_ITEM_REFERENCE'
    || code === 'BAD_FIELD_REFERENCE'
    || code === 'BAD_VAULT_REFERENCE';
}

plugin.registerRootDecorator({
  name: 'initOp',
  description: 'Initialize a 1Password plugin instance for op() resolver',
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
    pluginInstances[id] = new OpPluginInstance(id);
    // TODO: validate more

    if (objArgs.account && !objArgs.account.isStatic) {
      throw new SchemaError('Expected account to be static');
    }
    const account = objArgs?.account ? String(objArgs?.account?.staticValue) : undefined;

    // connectHost must be static (it's a server URL)
    if (objArgs.connectHost && !objArgs.connectHost.isStatic) {
      throw new SchemaError('Expected connectHost to be a static value');
    }
    const connectHost = objArgs?.connectHost ? String(objArgs?.connectHost?.staticValue) : undefined;

    // user should set one of: token, allowAppAuth, or connectHost+connectToken
    // we will check again later with resolved values
    if (!objArgs.token && !objArgs.allowAppAuth && !(connectHost && objArgs.connectToken)) {
      throw new SchemaError('Either token, allowAppAuth, or connectHost+connectToken must be set', {
        tip: [
          'Options:',
          '  1. Use a service account token: @initOp(token=$OP_SERVICE_ACCOUNT_TOKEN)',
          '  2. Use 1Password desktop app auth: @initOp(allowAppAuth=true)',
          '  3. Use a Connect server: @initOp(connectHost="http://connect:8080", connectToken=$OP_CONNECT_TOKEN)',
        ].join('\n'),
      });
    }

    // if connectHost is set, connectToken is required
    if (connectHost && !objArgs.connectToken) {
      throw new SchemaError('connectToken is required when connectHost is set', {
        tip: 'Add connectToken=$OP_CONNECT_TOKEN to your @initOp() call',
      });
    }

    return {
      id,
      account,
      connectHost,
      allowMissingResolver: objArgs.allowMissing,
      tokenResolver: objArgs.token,
      allowAppAuthResolver: objArgs.allowAppAuth,
      connectTokenResolver: objArgs.connectToken,
      useCliWithServiceAccountResolver: objArgs.useCliWithServiceAccount,
    };
  },
  async execute({
    id, account, connectHost, allowMissingResolver, tokenResolver,
    allowAppAuthResolver, connectTokenResolver, useCliWithServiceAccountResolver,
  }) {
    // even if these are empty, we can't throw errors yet
    // in case the instance is never actually used
    const token = await tokenResolver?.resolve();
    const enableAppAuth = await allowAppAuthResolver?.resolve();
    const connectToken = await connectTokenResolver?.resolve();
    const allowMissing = await allowMissingResolver?.resolve();
    const useCliWithServiceAccount = await useCliWithServiceAccountResolver?.resolve();
    pluginInstances[id].setAuth(
      token,
      !!enableAppAuth,
      account,
      connectHost,
      connectToken as string | undefined,
      allowMissing as boolean | undefined,
      !!useCliWithServiceAccount,
    );
  },
});


plugin.registerDataType({
  name: 'opServiceAccountToken',
  sensitive: true,
  typeDescription: 'Service account token used to authenticate with the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and [SDKs](https://developer.1password.com/docs/sdks/)',
  icon: OP_ICON,
  docs: [
    {
      description: '1Password service accounts',
      url: 'https://developer.1password.com/docs/service-accounts/',
    },
    'https://example.com',
  ],
  async validate(val) {
    if (!val.startsWith('ops_')) {
      throw new ValidationError('Service account tokens must start with ops_');
    }
  },
});

plugin.registerDataType({
  name: 'opConnectToken',
  sensitive: true,
  typeDescription: 'API token used to authenticate with a self-hosted [1Password Connect server](https://developer.1password.com/docs/connect/)',
  icon: OP_ICON,
  docs: [
    {
      description: '1Password Connect',
      url: 'https://developer.1password.com/docs/connect/',
    },
  ],
});

plugin.registerResolverFunction({
  name: 'op',
  label: 'Fetch single field value from 1Password',
  icon: OP_ICON,
  argsSchema: {
    type: 'mixed',
    arrayMinLength: 1,
  },
  process() {
    let instanceId = '_default';
    let itemLocationResolver: Resolver | undefined;

    if (this.arrArgs!.length === 1) {
      itemLocationResolver = this.arrArgs![0];
    } else if (this.arrArgs!.length === 2) {
      if (!(this.arrArgs![0].isStatic)) {
        throw new SchemaError('expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      itemLocationResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    // extract allowMissing named arg if provided
    const allowMissingResolver = this.objArgs?.allowMissing;

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No 1Password plugin instances found', {
        tip: 'Initialize at least one 1Password plugin instance using the @initOp root decorator',
      });
    }

    // make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('1Password plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initOp call',
            'or use `op(id, reference)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`1Password plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, itemLocationResolver, allowMissingResolver };
  },
  async resolve({ instanceId, itemLocationResolver, allowMissingResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const opReference = await itemLocationResolver.resolve();
    if (typeof opReference !== 'string') {
      throw new SchemaError('expected op item location to resolve to a string');
    }
    const allowMissing = allowMissingResolver ? !!(await allowMissingResolver.resolve()) : undefined;
    const shouldAllowMissing = allowMissing ?? selectedInstance.allowMissing;
    try {
      const opValue = await selectedInstance.readItem(opReference);
      return opValue;
    } catch (err) {
      if (shouldAllowMissing && isNotFoundError(err)) {
        return undefined;
      }
      throw err;
    }
  },
});

plugin.registerResolverFunction({
  name: 'opLoadEnvironment',
  label: 'Load all variables from a 1Password environment',
  icon: OP_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let environmentIdResolver: Resolver | undefined;

    if (this.arrArgs!.length === 1) {
      environmentIdResolver = this.arrArgs![0];
    } else if (this.arrArgs!.length === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      environmentIdResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No 1Password plugin instances found', {
        tip: 'Initialize at least one 1Password plugin instance using the @initOp root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('1Password plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initOp call',
            'or use `opLoadEnvironment(id, environmentId)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`1Password plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, environmentIdResolver };
  },
  async resolve({ instanceId, environmentIdResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const environmentId = await environmentIdResolver.resolve();
    if (typeof environmentId !== 'string') {
      throw new SchemaError('expected environment ID to resolve to a string');
    }
    return await selectedInstance.readEnvironment(environmentId);
  },
});
