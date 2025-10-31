import { ExecError, spawnAsync } from '@env-spec/utils/exec-helpers';
import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';

const { debug } = plugin;
const { ResolutionError } = plugin.ERRORS;

const ENABLE_BATCHING = true;

const OP_CLI_CACHE: Record<string, any> = {};

// for now we'll just use a single 1pass account for all requests
// but we'll likely want to support multiple accounts in the future
// note that the SDK does not currently support this - but service accounts are already limited to an account
let lockCliToOpAccount: string | undefined;

/*
  ! IMPORTANT INFO ON CLI AUTH

  Because we trigger multiple requests in parallel, if the app/cli is not unlocked, it will show multiple auth popups.
  In a big project this is super awkward because you may need to scan your finger over and over again.

  To work around this, we track if we are currently making the first op cli command, and if so acquire a mutex in the form of
  a deferred promise that other requests can then wait on. We also use the additional trick of checking `op whoami` so that
  if the app is already unlocked, we dont have to actually wait for the first request to finish to proceed with the rest.

  Ideally 1Password will fix this issue at some point and we can remove this extra logic.

  NOTE - We don't currently do anything special to handle if the user denies the login, or is logged into the wrong account.
*/

// use a singleton within the module to track op cli auth state as a mutex / deferred promise
let opAuthDeferred: DeferredPromise<boolean> | undefined;
async function checkOpCliAuth() {
  if (opAuthDeferred) {
    // if the deferred promise already exists, we'll just wait for it to complete
    await opAuthDeferred.promise;
  } else {
    // otherwise it means this is the first call of this function, so we create a new deferred promise
    // and return the resolve fn to be called after the first CLI method actually completes
    // except for one further trick, which is to first check if we are already logged in, and resolve right away
    opAuthDeferred = createDeferredPromise();
    return opAuthDeferred.resolve;
  }
}


export async function execOpCliCommand(cmdArgs: Array<string>) {
  // very simple in-memory cache, will persist between runs in watch mode
  // but need to think through how a user can opt out
  // and interact with this cache from the web UI when we add it for the regular cache
  const cacheKey = cmdArgs.join(' ');
  if (OP_CLI_CACHE[cacheKey]) {
    debug('op cli cache hit!');
    return OP_CLI_CACHE[cacheKey];
  }

  const startAt = new Date();

  const authCompletedFn = await checkOpCliAuth();
  try {
    // uses system-installed copy of `op`
    debug('op cli command args', cmdArgs);
    const cliResult = await spawnAsync('op', cmdArgs);
    authCompletedFn?.(true);
    debug(`> took ${+new Date() - +startAt}ms`);
    // OP_CLI_CACHE[cacheKey] = cliResult;
    return cliResult;
  } catch (err) {
    authCompletedFn?.(false);
    // eslint-disable-next-line no-use-before-define
    throw processOpCliError(err);
  }
}

/**
 * help try to turn `op` errors into something more helpful
 * this is all fairly brittle though because it depends on the error messages
 * luckily it should only _improve_ the experience, and is not critical
 */
function processOpCliError(err: Error | any) {
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


let opReadBatch: Record<string, { deferredPromises: Array<DeferredPromise<string>> }> | undefined;
const BATCH_READ_TIMEOUT = 50;

async function executeReadBatch(batchToExecute: NonNullable<typeof opReadBatch>) {
  debug('execute op read batch', Object.keys(batchToExecute));
  const envMap = {} as Record<string, string>;
  let i = 1;
  Object.keys(batchToExecute).forEach((opReference) => {
    envMap[`VARLOCK_1P_INJECT_${i++}`] = opReference;
  });
  const startAt = new Date();

  const authCompletedFn = await checkOpCliAuth();
  // `env -0` splits values by a null character instead of newlines
  // because otherwise we'll have trouble dealing with values that contain newlines
  await spawnAsync('op', `run --no-masking ${lockCliToOpAccount ? `--account ${lockCliToOpAccount} ` : ''}-- env -0`.split(' '), {
    env: {
      // have to pass through at least path so it can find `op`, but might need other items too?
      PATH: process.env.PATH!,
      // ...process.env as any,
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
        await executeReadBatch(batchToExecute);
      }
    });
}

/**
 * reads a single value from 1Password by reference (similar to `op read`)
 * but internally batches requests and uses `op run`
 * */
export async function opCliRead(opReference: string, account?: string) {
  lockCliToOpAccount ||= account;
  if (account && lockCliToOpAccount !== account) {
    throw new ResolutionError('Cannot use multiple different 1Password accounts when using CLI auth with batching enabled', {
      tip: [
        'When using CLI auth with batching, all references must use the same 1Password account',
        'Consider using service account tokens instead of CLI auth to allow multiple accounts',
      ],
    });
  }

  if (ENABLE_BATCHING) {
    // if no batch exists, we'll create it, and this function will kick it off after a timeout
    let shouldExecuteBatch = false;
    if (!opReadBatch) {
      opReadBatch = {};
      shouldExecuteBatch = true;
    }

    // otherwise we'll just add to the existing batch
    opReadBatch[opReference] ||= {
      deferredPromises: [],
    };

    const deferred = createDeferredPromise<string>();
    opReadBatch[opReference].deferredPromises.push(deferred);

    if (shouldExecuteBatch) {
      setTimeout(async () => {
        if (!opReadBatch) throw Error('expected to find op read batch!');
        const batchToExecute = opReadBatch;
        opReadBatch = undefined;
        await executeReadBatch(batchToExecute);
      }, BATCH_READ_TIMEOUT);
    }
    return deferred.promise;
  } else {
    // fetch each item individually
    const result = await execOpCliCommand([
      'read',
      '--force',
      '--no-newline',
      ...(lockCliToOpAccount ? ['--account', lockCliToOpAccount] : []),
      opReference,
    ]);
    return result;
  }
}

export function getIdsFromShareLink(opItemShareLinkUrl: string) {
  const url = new URL(opItemShareLinkUrl);
  const vaultId = url.searchParams.get('v')!;
  const itemId = url.searchParams.get('i')!;
  return { vaultId, itemId };
}
