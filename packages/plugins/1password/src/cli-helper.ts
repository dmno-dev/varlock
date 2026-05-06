import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';
import { plugin } from 'varlock/plugin-lib';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

const OP_CLI_CACHE: Record<string, any> = {};

/** Proxy env vars that must be forwarded so `op` can reach 1Password through HTTP/SOCKS proxies
 * (e.g. corporate proxies, container networks, sandboxed dev tools like Claude Code). */
const PROXY_ENV_KEYS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

export function pickProxyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export async function execOpCliCommand(cmdArgs: Array<string>, serviceAccountToken?: string) {
  // very simple in-memory cache, will persist between runs in watch mode
  // but need to think through how a user can opt out
  // and interact with this cache from the web UI when we add it for the regular cache
  const cacheKey = cmdArgs.join(' ');
  if (OP_CLI_CACHE[cacheKey]) {
    debug('op cli cache hit!');
    return OP_CLI_CACHE[cacheKey];
  }

  const startAt = new Date();

  try {
    // uses system-installed copy of `op`
    debug('op cli command args', cmdArgs);
    // strip OP_SERVICE_ACCOUNT_TOKEN from env so the CLI doesn't auto-detect it
    // when the user hasn't explicitly wired it into their schema.
    // When useCliWithServiceAccount is enabled the caller passes the token explicitly.
    const { OP_SERVICE_ACCOUNT_TOKEN: _, ...cleanEnv } = process.env;
    const cliResult = await spawnAsync('op', cmdArgs, {
      env: serviceAccountToken
        ? { ...cleanEnv, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken }
        : cleanEnv,
    });
    debug(`> took ${+new Date() - +startAt}ms`);
    // OP_CLI_CACHE[cacheKey] = cliResult;
    return cliResult;
  } catch (err) {
    // eslint-disable-next-line no-use-before-define
    throw processOpCliError(err);
  }
}

/**
 * help try to turn `op` errors into something more helpful
 * this is all fairly brittle though because it depends on the error messages
 * luckily it should only _improve_ the experience, and is not critical
 */
export function processOpCliError(err: Error | any) {
  if (err instanceof ExecError) {
    let errMessage = err.data;
    // get rid of "[ERROR] 2024/01/23 12:34:56 " before actual message
    debug('1pass cli error --', errMessage);
    if (errMessage.startsWith('[ERROR]')) errMessage = errMessage.substring(28);
    if (errMessage.includes('authorization prompt dismissed')) {
      return new ResolutionError('1Password app authorization prompt dismissed by user', {
        tip: [
          'By not using a service account token, you are relying on your local 1Password installation',
          'When the authorization prompt appears, you must authorize/unlock 1Password to allow access',
        ],
      });
    } else if (errMessage.includes("isn't a vault in this account")) {
      // message looks like -- "asdf" isn't a vault in this account...
      // so we will extract the vault name/id
      const matches = errMessage.match(/"([^"]+)" isn't a vault in this account/);
      const vaultNameOrId = matches?.[1] || 'unknown';
      return new ResolutionError(`1Password vault "${vaultNameOrId}" not found in account connected to op cli`, {
        code: 'BAD_VAULT_REFERENCE',
        extraMetadata: { badVaultId: vaultNameOrId },
        tip: [
          'By not using a service account token, you are relying on your local 1Password CLI installation and authentication.',
          'The account currently connected to the CLI does not contain (or have access to) the selected vault',
          'This must be resolved in your terminal - try running `op whoami` to see which account is connected to your `op` CLI.',
          'You may need to call `op signout` and `op signin` to select the correct account.',
        ],
      });
    } else if (errMessage.includes('could not find item')) {
      // message includes `"item name" isn't an item in the "vault name" vault`
      const matches = errMessage.match(/could not find item (.+) in vault (.+)/);
      const itemNameOrId = matches?.[1] || 'unknown';
      const vaultId = matches?.[2] || 'unknown';

      // const vaultNameOrId = errMessage.substring(1, errMessage.substring(1).indexOf('"') + 1);
      return new ResolutionError(`1Password item "${itemNameOrId}" not found in vault "${vaultId}"`, {
        code: 'BAD_ITEM_REFERENCE',
        extraMetadata: { badItemId: itemNameOrId, vaultId },
        tip: [
          'Double check the item in your 1Password vault.',
          'It is always safer to use IDs since they are more stable than names.',
        ],
      });
    } else if (errMessage.includes(' does not have a field ')) {
      // message includes `item 'dev test/example' does not have a field 'bad field name'`
      const matches = errMessage.match(/item '([^']+)' does not have a field '([^']+)'/);
      const itemNameOrId = matches?.[1] || 'unknown';
      const [vaultId, itemId] = itemNameOrId.split('/');
      const fieldNameOrId = matches?.[2]?.replace('.', '/') || 'unknown';

      // const vaultNameOrId = errMessage.substring(1, errMessage.substring(1).indexOf('"') + 1);
      return new ResolutionError(`1Password vault "${vaultId}" item "${itemId}" does not have field "${fieldNameOrId}"`, {
        code: 'BAD_FIELD_REFERENCE',
        extraMetadata: { vaultId, itemId, badFieldId: fieldNameOrId },
        tip: ['Double check the field name/id in your item.'],
        // TODO: add link to item?
      });
    } else if (errMessage.includes('unknown command "environment"')) {
      return new ResolutionError('1Password CLI does not support the "environment" command', {
        tip: [
          'The `op environment` command requires a beta version of the 1Password CLI (v2.33.0+).',
          'Download it from https://app-updates.agilebits.com/product_history/CLI2 (click "show betas").',
        ],
      });
    } else if (errMessage.toLowerCase().includes('environment') && (errMessage.includes('not found') || errMessage.includes('invalid'))) {
      return new ResolutionError('1Password environment not found', {
        tip: [
          'Verify the environment ID is correct.',
          'You can find it in the 1Password app under Developer > View Environments.',
          'See https://developer.1password.com/docs/environments/',
        ],
      });
    }

    // when the desktop app integration is not connected, some interactive CLI help is displayed
    // however if it dismissed, we get an error with no message
    // TODO: figure out the right workflow here?
    if (!errMessage) {
      return new ResolutionError('1Password CLI not configured', {
        tip: [
          'By not using a service account token, you are relying on your local 1Password CLI installation and authentication.',
          'You many need to enable the 1Password Desktop app integration, see https://developer.1password.com/docs/cli/get-started/#step-2-turn-on-the-1password-desktop-app-integration',
          'Try running `op whoami` to make sure the CLI is connected to the correct account',
          'You may need to call `op signout` and `op signin` to select the correct account.',
        ],
      });
    }
    return new Error(`1Password CLI error - ${errMessage || 'unknown'}`);
  } else if ((err as any).code === 'ENOENT') {
    return new ResolutionError('1Password CLI `op` not found', {
      tip: [
        'By not using a service account token, you are relying on your local 1Password CLI installation for ambient auth.',
        'But your local 1Password CLI (`op`) was not found. Install it here - https://developer.1password.com/docs/cli/get-started/',
      ],
    });
  } else {
    return new ResolutionError(`Problem invoking 1Password CLI: ${(err as any).message}`);
  }
}

export async function opCliEnvironmentRead(
  environmentId: string,
  account?: string,
  serviceAccountToken?: string,
): Promise<string> {
  const result = await execOpCliCommand([
    'environment',
    'read',
    environmentId,
    ...(account ? ['--account', account] : []),
  ], serviceAccountToken);
  return result;
}

export function getIdsFromShareLink(opItemShareLinkUrl: string) {
  const url = new URL(opItemShareLinkUrl);
  const vaultId = url.searchParams.get('v')!;
  const itemId = url.searchParams.get('i')!;
  return { vaultId, itemId };
}
