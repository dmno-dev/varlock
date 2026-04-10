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
 * Execute a Bitwarden CLI command using the provided session token.
 * The session token is passed via the BW_SESSION environment variable so it
 * never appears in the process argument list.
 */
export async function execBwCliCommand(args: Array<string>, sessionToken: string): Promise<string> {
  const startAt = Date.now();
  try {
    debug('bw cli args', args);
    const result = await spawnAsync('bw', args, {
      env: {
        ...process.env,
        BW_SESSION: sessionToken,
      },
    });
    debug(`> took ${Date.now() - startAt}ms`);
    return result.trim();
  } catch (err) {
    throw processBwCliError(err, args);
  }
}

function processBwCliError(err: unknown, args?: Array<string>): Error {
  // CLI binary not found
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new ResolutionError('Bitwarden CLI `bw` not found', {
      tip: [
        'The Bitwarden CLI must be installed and available in PATH',
        'Install from: https://bitwarden.com/help/cli/',
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
      errMsg.includes('Session key is invalid')
      || errMsg.includes('Not logged in')
      || errMsg.includes('You are not logged in')
      || errMsg.includes('session')
    ) {
      return new ResolutionError('Bitwarden CLI session is invalid or expired', {
        tip: [
          'Your BW_SESSION token may be invalid or expired',
          'Unlock your vault to get a fresh session token:  bw unlock',
          'Then set BWP_SESSION (or whichever env var you use) to the returned token',
        ].join('\n'),
      });
    }

    if (errMsg.includes('Not found') || errMsg.includes('not found')) {
      const itemArg = args ? args[args.length - 1] : 'unknown';
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
