import { spawn, spawnSync } from 'node:child_process';
import { ExecError } from '@env-spec/utils/exec-helpers';

type ErrorCtor = new (msg: string, opts?: { tip?: string; isWarning?: boolean }) => Error;

const FIX_INSTALL_TIP = [
  'The `dcli` command was not found on your system.',
  'Install it following the instructions at:',
  '  https://cli.dashlane.com/installation',
].join('\n');

export const DEFAULT_DCLI_TIMEOUT_MS = 30_000;

/** Thrown when a dcli call is killed by our spawn timeout (or an external signal) */
class DcliTimeoutError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`dcli was killed by ${signal} before completing`);
  }
}

export class DashlanePluginInstance {
  private serviceDeviceKeys?: string;
  private cache = new Map<string, string>();
  private dcliChecked = false;
  private dcliCheckPromise?: Promise<void>;
  private autoSync = false;
  private syncPromise?: Promise<void>;
  private synced = false;
  private lockAfter = false;
  private onLocked: 'error' | 'warn' = 'error';
  private timeoutMs = DEFAULT_DCLI_TIMEOUT_MS;

  constructor(
    readonly id: string,
    private ResolutionError: ErrorCtor,
  ) {}

  configure(serviceDeviceKeys?: string, opts?: {
    autoSync?: boolean;
    lockOnExit?: boolean;
    onLocked?: 'error' | 'warn';
    timeoutMs?: number;
  }) {
    this.serviceDeviceKeys = serviceDeviceKeys;
    if (opts?.autoSync !== undefined) this.autoSync = opts.autoSync;
    this.lockAfter = opts?.lockOnExit ?? !!serviceDeviceKeys;
    if (opts?.onLocked !== undefined) this.onLocked = opts.onLocked;
    if (opts?.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
  }

  /** @internal telemetry: whether this instance auto-syncs the vault before reads */
  get telemetryAutoSync() { return this.autoSync; }

  /** @internal telemetry: whether this instance locks the vault on process exit */
  get telemetryLockOnExit() { return this.lockAfter; }

  private get spawnEnv(): Record<string, string> | undefined {
    if (!this.serviceDeviceKeys) return undefined;
    return {
      ...process.env as Record<string, string>,
      DASHLANE_SERVICE_DEVICE_KEYS: this.serviceDeviceKeys,
    };
  }

  /**
   * Run a dcli subcommand with stdin closed and a hard timeout.
   *
   * On a locked vault, dcli prompts for the master password and waits on stdin.
   * With piped stdio and no timeout that call never returns, hanging the whole
   * load. Ignoring stdin makes the prompt hit EOF and fail immediately; the
   * timeout is a backstop for any other way dcli can stall.
   */
  private execDcli(args: Array<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn('dcli', args, {
        ...this.spawnEnv && { env: this.spawnEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr!.on('data', (data) => {
        stderr += data.toString();
      });
      child.on('error', reject);
      child.on('exit', (exitCode, signal) => {
        if (exitCode === 0) {
          resolve(stdout);
        } else if (signal) {
          reject(new DcliTimeoutError(signal));
        } else {
          reject(new ExecError(exitCode ?? 1, signal, stderr));
        }
      });
    });
  }

  async ensureDcliInstalled(): Promise<void> {
    if (this.dcliChecked) return;
    this.dcliCheckPromise ||= this.doDcliCheck();
    await this.dcliCheckPromise;
  }

  private async doDcliCheck(): Promise<void> {
    try {
      await this.execDcli(['--version']);
      this.dcliChecked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.dcliCheckPromise = undefined; // allow retry
        throw new this.ResolutionError('`dcli` command not found', { tip: FIX_INSTALL_TIP });
      }
      // dcli --version might fail for other reasons but if the binary exists, that's fine
      this.dcliChecked = true;
    }
  }

  private async syncOnce(): Promise<void> {
    if (!this.autoSync || this.synced) return;
    this.syncPromise ||= this.doSync().catch((err) => {
      this.syncPromise = undefined;
      throw err;
    });
    await this.syncPromise;
  }

  private async doSync(): Promise<void> {
    await this.ensureDcliInstalled();
    try {
      await this.execDcli(['sync']);
    } catch {
      // Sync failure should not block reads - vault may still have recent data
    }
    this.synced = true;
  }

  /**
   * Synchronously lock the vault. Uses spawnSync so it is safe to call
   * from process 'exit' handlers where async work cannot run.
   */
  lockVaultSync(): void {
    if (!this.lockAfter) return;
    try {
      spawnSync('dcli', ['lock'], {
        env: this.spawnEnv ?? process.env as Record<string, string>,
        timeout: 5000,
        stdio: 'ignore',
      });
    } catch {
      // Best-effort - don't fail if lock fails
    }
  }

  /**
   * Read a secret by dl:// reference.
   * Supports both dl://<id>/field (fast, skips vault decryption)
   * and dl://<title>/field (slower, requires full vault sync).
   */
  async readReference(dlUri: string): Promise<string> {
    if (!dlUri.startsWith('dl://') || dlUri === 'dl://') {
      throw new this.ResolutionError(`Invalid Dashlane reference: "${dlUri}"`, {
        tip: 'References must start with dl:// and include a path — e.g. dashlane("dl://<id>/password")',
      });
    }

    await this.ensureDcliInstalled();
    await this.syncOnce();

    if (this.cache.has(dlUri)) {
      return this.cache.get(dlUri)!;
    }

    try {
      const result = await this.execDcli(['read', dlUri]);
      const value = result.replace(/\n$/, '');
      this.cache.set(dlUri, value);
      return value;
    } catch (err) {
      return this.handleDcliError(err, dlUri);
    }
  }

  /**
   * Locked/unsynced vault error. With onLocked=warn this is thrown as a
   * warning, so the item resolves empty and the load can still pass
   * (unless the item is required).
   */
  private throwLockedVaultError(details?: string): never {
    throw new this.ResolutionError(
      `Dashlane vault appears locked or not synced${details ? ` (${details})` : ''}`,
      {
        tip: [
          'Run `dcli sync` to sync and unlock your vault.',
          'Or set autoSync=true in @initDashlane to sync automatically.',
          'Set onLocked=warn in @initDashlane to downgrade this to a warning.',
        ].join('\n'),
        ...this.onLocked === 'warn' && { isWarning: true },
      },
    );
  }

  private handleDcliError(err: unknown, context: string): never {
    if (err instanceof DcliTimeoutError) {
      this.throwLockedVaultError(`dcli did not respond within ${this.timeoutMs}ms`);
    }

    if (err instanceof ExecError) {
      const msg = err.data || err.message;

      if (msg.match(/not found/i) || msg.match(/does not exist/i) || msg.match(/no matching/i)) {
        throw new this.ResolutionError(`Entry "${context}" not found in Dashlane vault`, {
          tip: [
            'Verify the entry exists: dcli password -o json | jq \'.[].title\'',
            'Use the entry ID for reliable lookups: dashlane("dl://<id>/password")',
          ].join('\n'),
        });
      }

      if (msg.match(/locked/i) || msg.match(/sync/i) || msg.match(/master password/i)) {
        this.throwLockedVaultError();
      }

      if (msg.match(/auth/i) || msg.match(/credential/i) || msg.match(/login/i)) {
        throw new this.ResolutionError('Dashlane authentication failed', {
          tip: [
            'Ensure you are logged in to Dashlane CLI:',
            '  dcli sync',
            'Or provide service device keys for headless auth.',
          ].join('\n'),
        });
      }

      throw new this.ResolutionError(`Failed to fetch "${context}" from Dashlane: ${msg}`);
    }

    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new this.ResolutionError('`dcli` command not found', { tip: FIX_INSTALL_TIP });
    }

    throw new this.ResolutionError(
      `Failed to fetch "${context}" from Dashlane: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
