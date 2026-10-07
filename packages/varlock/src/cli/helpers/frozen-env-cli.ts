import { findFrozenEnv, type FrozenEnvInfo, USE_INJECTED_ENV_VAR } from '../../lib/injected-env-reuse';
import { PreResolvedEnvError, USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import { CliExitError } from './exit-error';

/**
 * A pre-resolved env (frozen env file, or a blob under `_VARLOCK_USE_INJECTED_ENV=1`) that is
 * requested but unusable, as a CliExitError carrying the error's own suggestion. Neither ever
 * falls back to fresh resolution.
 */
export function frozenEnvErrorToCliExitError(err: unknown): CliExitError {
  const message = (err as Error).message.replace(/^\[varlock\] /, '');
  return new CliExitError(message, {
    suggestion: err instanceof PreResolvedEnvError
      ? err.suggestion
      : `Provide a valid __VARLOCK_ENV payload, or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files.`,
  });
}

/** CLI wrapper around findFrozenEnv, with an unusable frozen env as a CliExitError */
export function getFrozenEnv(): FrozenEnvInfo | undefined {
  try {
    return findFrozenEnv({ env: process.env, cwd: process.cwd() });
  } catch (err) {
    throw frozenEnvErrorToCliExitError(err);
  }
}

/**
 * Apply `--frozen` (see FROZEN_ARG) by setting `_VARLOCK_USE_FROZEN_ENV`, so the flag behaves
 * exactly like the env var everywhere downstream: the frozen env lookup, the child env, and any
 * nested varlock process.
 */
export function applyFrozenArg(value: string | undefined) {
  if (value === undefined) return;
  process.env[USE_FROZEN_ENV_VAR] = value || '1';
}

