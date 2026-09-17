import { findPinnedGraphForResolution, type PinnedGraphInfo, USE_INJECTED_ENV_VAR } from '../../lib/injected-env-reuse';
import { FrozenEnvFileError, USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import { CliExitError } from './exit-error';

/**
 * CLI wrapper around findPinnedGraphForResolution: same lookup, with an unusable pin turned
 * into a CliExitError (a pin that is present but broken never falls back to fresh resolution).
 */
export function getPinnedGraphForResolution(opts: { explicitFrozenOnly: boolean }): PinnedGraphInfo | undefined {
  try {
    return findPinnedGraphForResolution({
      env: process.env,
      cwd: process.cwd(),
      explicitFrozenOnly: opts.explicitFrozenOnly,
    });
  } catch (err) {
    const message = (err as Error).message.replace(/^\[varlock\] /, '');
    if (err instanceof FrozenEnvFileError) {
      throw new CliExitError(message, {
        suggestion: 'Re-create it with `varlock freeze`, make sure _VARLOCK_ENV_KEY matches the key it was frozen with, '
          + `or set ${USE_FROZEN_ENV_VAR}=0 to resolve from .env files instead.`,
      });
    }
    throw new CliExitError(message, {
      suggestion: `Provide a valid __VARLOCK_ENV payload, or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files.`,
    });
  }
}
