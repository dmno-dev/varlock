

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import * as localEncrypt from '../../lib/local-encrypt';
import { CliExitError } from '../helpers/exit-error';
import { commandSpec } from './lock.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
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
