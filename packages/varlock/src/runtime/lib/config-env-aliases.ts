/**
 * Some platforms reject env var names that start with an underscore (AWS Lambda requires
 * `[a-zA-Z][a-zA-Z0-9_]+`), so the `_VARLOCK_*` config vars cannot be set there directly.
 * Each one can also be set without the leading underscore (`VARLOCK_ENV_KEY` for
 * `_VARLOCK_ENV_KEY`); the underscore form wins when both are set.
 *
 * Kept as a plain list of names (rather than importing `VARLOCK_CONFIG_ENV_VARS`) because this
 * runs inside the edge-safe init bundles. A test keeps it in sync with reserved-vars.ts.
 */
export const VARLOCK_CONFIG_ENV_VAR_NAMES = [
  '_VARLOCK_ENV_KEY',
  '_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV',
  '_VARLOCK_CACHE_KEY',
  '_VARLOCK_REDACT_STDOUT',
  '_VARLOCK_FILTER',
  '_VARLOCK_THROW_ON_LOAD_ERROR',
  '_VARLOCK_DYNAMIC_BUILD_ACCESS_MODE',
  '_VARLOCK_USE_INJECTED_ENV',
  '_VARLOCK_ALLOW_EMPTY_CONFIG',
  '_VARLOCK_USE_FROZEN_ENV',
] as const;

/** The underscore-free alias names themselves (`VARLOCK_ENV_KEY`, ...) */
export const VARLOCK_CONFIG_ENV_VAR_ALIAS_NAMES: ReadonlySet<string> = new Set(
  VARLOCK_CONFIG_ENV_VAR_NAMES.map((name) => name.slice(1)),
);

type ConfigEnvVarName = typeof VARLOCK_CONFIG_ENV_VAR_NAMES[number];

/**
 * Read a `_VARLOCK_*` config var, falling back to its underscore-free alias. Use where the
 * value matters even if process.env is read-only (so `applyVarlockConfigEnvAliases` could
 * not copy the alias over).
 */
export function getVarlockConfigEnvVar(
  name: ConfigEnvVarName,
  env: Record<string, string | undefined> | undefined = (globalThis as any).process?.env,
): string | undefined {
  return env?.[name] || env?.[name.slice(1)] || undefined;
}

/**
 * Copy each underscore-free alias (`VARLOCK_ENV_KEY`) onto its `_VARLOCK_*` name when that
 * name is not already set, so every reader of the `_VARLOCK_*` name sees it.
 * Mutates `env` (process.env by default). Safe to call more than once, and a no-op where
 * process.env is missing or read-only (some edge runtimes).
 */
export function applyVarlockConfigEnvAliases(
  env: Record<string, string | undefined> | undefined = (globalThis as any).process?.env,
) {
  if (!env) return;
  for (const name of VARLOCK_CONFIG_ENV_VAR_NAMES) {
    if (env[name] !== undefined && env[name] !== '') continue;
    const aliasValue = env[name.slice(1)];
    if (aliasValue === undefined || aliasValue === '') continue;
    try {
      env[name] = aliasValue;
    } catch {
      // read-only process.env
    }
  }
}
