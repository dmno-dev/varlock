import { spawnAsync, ExecError } from '@env-spec/utils/exec-helpers';

type ErrorCtor = new (msg: string, opts?: { tip?: string }) => Error;

const FIX_INSTALL_TIP = [
  'The `dcli` command was not found on your system.',
  'Install it using your package manager:',
  '  macOS:  brew install dashlane/tap/dcli',
  '  npm:    npm install -g @dashlane/cli',
  'See https://cli.dashlane.com/installation for more info.',
].join('\n');

export class DashlanePluginInstance {
  private serviceDeviceKeys?: string;
  private cache = new Map<string, string>();
  private dcliChecked = false;

  constructor(
    readonly id: string,
    private ResolutionError: ErrorCtor,
  ) {}

  configure(serviceDeviceKeys?: string) {
    this.serviceDeviceKeys = serviceDeviceKeys;
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
    try {
      await spawnAsync('dcli', ['--version'], this.spawnOpts);
      this.dcliChecked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new this.ResolutionError('`dcli` command not found', { tip: FIX_INSTALL_TIP });
      }
      // dcli --version might fail for other reasons but if the binary exists, that's fine
      this.dcliChecked = true;
    }
  }

  /**
   * Read a secret by dl:// reference.
   * Supports both dl://<id>/field (fast, skips vault decryption)
   * and dl://<title>/field (slower, requires full vault sync).
   */
  async readReference(dlUri: string): Promise<string> {
    if (!dlUri.startsWith('dl://')) {
      throw new this.ResolutionError(`Invalid Dashlane reference: "${dlUri}"`, {
        tip: 'References must start with dl:// — e.g. dashlane("dl://<id>/password")',
      });
    }

    await this.ensureDcliInstalled();

    if (this.cache.has(dlUri)) {
      return this.cache.get(dlUri)!;
    }

    try {
      const result = await spawnAsync('dcli', ['read', dlUri], this.spawnOpts);
      const value = result.trimEnd();
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
          tip: 'Run `dcli sync` to sync your vault.',
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
