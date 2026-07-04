import { CliExitError } from './exit-error';

const VALID_INJECT_MODES = ['all', 'vars', 'blob'] as const;

/**
 * Resolve the `--inject` flag into the two injection booleans, validating the
 * value. Shared by `varlock run` and `varlock proxy run` so the accepted modes
 * and their meaning can't drift between the two commands.
 */
export function resolveInjectMode(mode: string | undefined, fallback: 'all' | 'vars' | 'blob' = 'all'): {
  injectVars: boolean;
  injectBlob: boolean;
} {
  const injectMode = mode ?? fallback;
  if (!(VALID_INJECT_MODES as ReadonlyArray<string>).includes(injectMode)) {
    throw new CliExitError(`Invalid --inject mode: "${injectMode}". Must be one of: ${VALID_INJECT_MODES.join(', ')}`);
  }
  return {
    injectVars: injectMode === 'all' || injectMode === 'vars',
    injectBlob: injectMode === 'all' || injectMode === 'blob',
  };
}
