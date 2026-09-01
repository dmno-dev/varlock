

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import * as localEncrypt from '../../lib/local-encrypt';
import { CliExitError } from '../helpers/exit-error';
import { commandSpec } from './lock.command-spec';
// Imported straight from its own module rather than through the library's
// index: forgetting a preference is a CLI errand, and re-exporting it would
// pull the file into every process that loads varlock as a library.
import { forgetUnlockPreferences } from '../../lib/local-encrypt/unlock-preferences';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // Forgetting is a file edit in the user's own varlock directory, not a daemon
  // op, so it works whether or not anything is running and whether or not this
  // machine has a backend that can lock at all.
  const forgetAll = Boolean(ctx.values['forget-all-preferences']);
  const forgetHere = Boolean(ctx.values['forget-preferences']);
  if (forgetAll || forgetHere) {
    const forgotten = forgetUnlockPreferences(
      forgetAll ? undefined : { projectPath: process.cwd() },
    );
    const where = forgetAll ? 'this Mac' : 'this project';
    console.log(
      forgotten > 0
        ? `Forgot ${forgotten} remembered unlock choice${forgotten !== 1 ? 's' : ''} for ${where}.`
        : `No remembered unlock choices for ${where}.`,
    );
  }

  const backend = localEncrypt.getBackendInfo();

  if (!backend.biometricAvailable) {
    console.log(`The ${backend.type} backend does not support biometric lock.`);
    return;
  }

  const namedSession = ctx.values.session;
  const current = Boolean(ctx.values.current);

  if (namedSession && current) {
    throw new CliExitError('Pass either --session or --current, not both', {
      suggestion: '--current locks the session you are running in; --session locks one you name.',
    });
  }

  let sessionId = namedSession;
  if (current) {
    // --current takes no id on purpose. The daemon derives the session from the
    // connection, so asking it who we are is the only way to name our own
    // session, and there is no way to name anyone else's.
    sessionId = await localEncrypt.getCurrentSessionId();
    if (!sessionId) {
      console.log('No unlock session is open for this terminal, so there is nothing to lock.');
      return;
    }
  }

  try {
    const invalidated = await localEncrypt.lockSession(sessionId ? { sessionId } : undefined);

    if (sessionId) {
      console.log(
        invalidated > 0
          ? `Locked ${invalidated} session grant${invalidated !== 1 ? 's' : ''} for ${sessionId}.`
          : `No unlock session grants were open for ${sessionId}.`,
      );
      return;
    }
    console.log('Encryption session locked. Approval will be required for the next decrypt.');
  } catch {
    console.log('No encryption daemon is running — nothing to lock.');
  }
};
