import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';
import { plugin } from 'varlock/plugin-lib';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

export interface BwItem {
  id: string;
  name: string;
  type: number;
  notes?: string;
  login?: {
    username?: string;
    password?: string;
    totp?: string;
    uris?: Array<{ uri: string; match?: number | null }>;
  };
  fields?: Array<{ name: string; value: string; type: number; linkedId?: string | null }>;
}

/**
 * Whether a `bw` CLI error message indicates the session token is unusable —
 * i.e. expired, locked (externally), invalid, or never established. Matched
 * against real CLI output: a stale session on `bw get` reports "Vault is
 * locked.", and a wrong master password on `bw unlock` reports a
 * "Cryptography error, The decryption operation failed".
 */
export function isInvalidSessionMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('session')
    || m.includes('not logged in')
    || m.includes('is locked')
    || m.includes('invalid master password')
    || m.includes('decryption operation failed')
    || m.includes('cryptography error');
}

function processBwCliError(err: unknown, args?: Array<string>): Error {
  // CLI binary not found
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new ResolutionError('Bitwarden CLI `bw` not found', {
      tip: [
        'The Bitwarden CLI must be installed and available in PATH',
        'Install via a trusted source - https://bitwarden.com/help/cli/',
        'macOS:   brew install bitwarden-cli',
        'Linux:   snap install bw',
        'Windows: choco install bitwarden-cli',
      ].join('\n'),
    });
  }

  if (err instanceof ExecError) {
    const errMsg = err.data;
    debug('bw cli error --', errMsg);

    if (
      errMsg.includes('You are not logged in')
      || errMsg.includes('Not logged in')
    ) {
      return new ResolutionError('Not logged in to the Bitwarden CLI', {
        tip: [
          'Log in once with your account: bw login',
          '(varlock will handle unlocking + caching the session token after that)',
        ].join('\n'),
      });
    }

    if (isInvalidSessionMessage(errMsg)) {
      return new ResolutionError('Bitwarden CLI unlock failed or session is invalid', {
        tip: [
          'The master password may be incorrect, or the cached session expired/locked',
          'Try again, or run `bw unlock` manually to confirm your credentials',
        ].join('\n'),
      });
    }

    if (errMsg.includes('Not found') || errMsg.includes('not found')) {
      const itemArg = args ? args.filter((a) => !a.startsWith('--')).pop() ?? 'unknown' : 'unknown';
      return new ResolutionError(`Bitwarden item "${itemArg}" not found`, {
        tip: [
          'Verify the item name or UUID is correct',
          'Check that the item exists in your Bitwarden/Vaultwarden vault',
        ].join('\n'),
      });
    }

    return new ResolutionError(`Bitwarden CLI error: ${errMsg || 'unknown'}`, {
      tip: 'Run `bw` in your terminal to check whether the CLI is working correctly',
    });
  }

  return new ResolutionError(
    `Failed to run Bitwarden CLI: ${(err as Error)?.message || String(err)}`,
  );
}

/**
 * Execute a Bitwarden CLI command using the provided session token.
 * The session token is passed via the BW_SESSION environment variable so it
 * never appears in the process argument list.
 *
 * `appDataDir` (optional) selects a specific bw CLI data directory via
 * BITWARDENCLI_APPDATA_DIR — used to target a distinct account/server.
 */
export async function execBwCliCommand(
  args: Array<string>,
  sessionToken: string,
  opts: { appDataDir?: string } = {},
): Promise<string> {
  const startAt = Date.now();
  try {
    debug('bw cli args', args);
    const result = await spawnAsync('bw', args, {
      env: {
        ...process.env,
        BW_SESSION: sessionToken,
        ...(opts.appDataDir ? { BITWARDENCLI_APPDATA_DIR: opts.appDataDir } : {}),
      },
    });
    debug(`> took ${Date.now() - startAt}ms`);
    return result.trim();
  } catch (err) {
    throw processBwCliError(err, args);
  }
}

/**
 * Unlock the vault and return a fresh raw session token.
 *
 * IMPORTANT: each `bw unlock` invalidates any previously issued session keys,
 * so callers must cache the result rather than unlocking on every resolution.
 *
 * - When `masterPassword` is provided, unlock runs non-interactively (suitable
 *   for CI or composing with another resolver such as a keychain lookup).
 * - Otherwise the master-password prompt is shown on the TTY; stdout (the raw
 *   key) is captured while stdin/stderr are inherited. Requires an interactive
 *   terminal — callers should guard on `process.stdin.isTTY`.
 *
 * `appDataDir` (optional) selects a specific bw CLI data directory via
 * BITWARDENCLI_APPDATA_DIR — so the unlock targets the matching account/server.
 */
export async function unlockVault(opts: { masterPassword?: string; appDataDir?: string } = {}): Promise<string> {
  const startAt = Date.now();
  const appDataEnv = opts.appDataDir ? { BITWARDENCLI_APPDATA_DIR: opts.appDataDir } : {};
  try {
    let token: string;
    if (opts.masterPassword !== undefined) {
      debug('bw unlock (non-interactive)');
      // pass the password via env (never in argv); --raw emits only the session key
      token = await spawnAsync('bw', ['unlock', '--raw', '--passwordenv', 'BW_VARLOCK_MASTERPW'], {
        env: { ...process.env, ...appDataEnv, BW_VARLOCK_MASTERPW: opts.masterPassword },
      });
    } else {
      debug('bw unlock (interactive)');
      // inherit stdin/stderr so the master-password prompt is shown and answered
      // on the user's terminal; capture stdout, which (with --raw) is only the key
      token = await spawnAsync('bw', ['unlock', '--raw'], {
        env: { ...process.env, ...appDataEnv },
        stdio: ['inherit', 'pipe', 'inherit'],
      });
    }
    debug(`> unlock took ${Date.now() - startAt}ms`);
    return token.trim();
  } catch (err) {
    throw processBwCliError(err, ['unlock']);
  }
}
