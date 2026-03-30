import { spawnSync } from 'node:child_process';
import { spawnAsync, ExecError } from '@env-spec/utils/exec-helpers';

type ErrorCtor = new (msg: string, opts?: { tip?: string }) => Error;

const FIX_INSTALL_TIP = [
  'The `dcli` command was not found on your system.',
  'Install it following the instructions at:',
  '  https://cli.dashlane.com/installation',
].join('\n');

export class DashlanePluginInstance {
  private serviceDeviceKeys?: string;
  private cache = new Map<string, string>();
  private dcliChecked = false;
  private dcliCheckPromise?: Promise<void>;
  private autoSync = false;
  private syncPromise?: Promise<void>;
  private synced = false;
  private lockAfter = false;

  constructor(
    readonly id: string,
    private ResolutionError: ErrorCtor,
  ) {}

  configure(serviceDeviceKeys?: string, opts?: { autoSync?: boolean; lockOnExit?: boolean }) {
    this.serviceDeviceKeys = serviceDeviceKeys;
    if (opts?.autoSync !== undefined) this.autoSync = opts.autoSync;
    this.lockAfter = opts?.lockOnExit ?? !!serviceDeviceKeys;
  }

  private get spawnEnv(): Record<string, string> | undefined {
    if (!this.serviceDeviceKeys) return undefined;
    return {
      ...process.env as Record<string, string>,
      DASHLANE_SERVICE_DEVICE_KEYS: this.serviceDeviceKeys,
    };
  }

  private get spawnOpts(): { env: Record<string, string> } | undefined {
    const env = this.spawnEnv;
    return env ? { env } : undefined;
  }

  async ensureDcliInstalled(): Promise<void> {
    if (this.dcliChecked) return;
    if (!this.dcliCheckPromise) {
      this.dcliCheckPromise = this.doDcliCheck();
    }
    await this.dcliCheckPromise;
  }

  private async doDcliCheck(): Promise<void> {
    try {
      await spawnAsync('dcli', ['--version'], this.spawnOpts);
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
    if (!this.syncPromise) {
      this.syncPromise = this.doSync().catch((err) => {
        this.syncPromise = undefined;
        throw err;
      });
    }
    await this.syncPromise;
  }

  private async doSync(): Promise<void> {
    await this.ensureDcliInstalled();
    try {
      await spawnAsync('dcli', ['sync'], this.spawnOpts);
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
      const result = await spawnAsync('dcli', ['read', dlUri], this.spawnOpts);
      const value = result.replace(/\n$/, '');
      this.cache.set(dlUri, value);
      return value;
    } catch (err) {
      return this.handleDcliError(err, dlUri);
    }
  }

  private handleDcliError(err: unknown, context: string): never {
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

      if (msg.match(/auth/i) || msg.match(/credential/i) || msg.match(/login/i)) {
        throw new this.ResolutionError('Dashlane authentication failed', {
          tip: [
            'Ensure you are logged in to Dashlane CLI:',
            '  dcli sync',
            'Or provide service device keys for headless auth.',
          ].join('\n'),
        });
      }

      if (msg.match(/locked/i) || msg.match(/sync/i)) {
        throw new this.ResolutionError('Dashlane vault appears locked or not synced', {
          tip: [
            'Run `dcli sync` to sync your vault.',
            'Or set autoSync=true in @initDashlane to sync automatically.',
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
