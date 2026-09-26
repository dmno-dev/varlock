import { findPinnedGraphForResolution, type PinnedGraphInfo, USE_INJECTED_ENV_VAR } from '../../lib/injected-env-reuse';
import { FrozenEnvFileError } from '../../lib/frozen-env-file';
import { CliExitError } from './exit-error';

/**
 * A pre-resolved env (frozen env file, or a blob under `_VARLOCK_USE_INJECTED_ENV=1`) that is
 * requested but unusable, as a CliExitError. Neither ever falls back to fresh resolution.
 */
export function pinErrorToCliExitError(err: unknown): CliExitError {
  const message = (err as Error).message.replace(/^\[varlock\] /, '');
  return new CliExitError(message, {
    suggestion: err instanceof FrozenEnvFileError
      ? err.suggestion
      : 'Provide a valid __VARLOCK_ENV blob (e.g. captured via `varlock load --format json-full --compact`), '
        + `or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files.`,
  });
}

/** CLI wrapper around findPinnedGraphForResolution, with an unusable pin as a CliExitError */
export function getPinnedGraphForResolution(): PinnedGraphInfo | undefined {
  try {
    return findPinnedGraphForResolution({ env: process.env, cwd: process.cwd() });
  } catch (err) {
    throw pinErrorToCliExitError(err);
  }
}
