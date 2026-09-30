/**
 * Loading an empty config (no .env files found, or files with no items defined) is an error
 * everywhere, including `load --format json-full` (used by `varlock/auto-load` and the framework
 * integrations), unless the user explicitly opts in with `_VARLOCK_ALLOW_EMPTY_CONFIG`.
 */

export const ALLOW_EMPTY_CONFIG_ENV_VAR = '_VARLOCK_ALLOW_EMPTY_CONFIG';

/** true when the user explicitly opted in to running with an empty config */
export function isEmptyConfigAllowed(env: Record<string, string | undefined> = process.env) {
  const value = env[ALLOW_EMPTY_CONFIG_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
