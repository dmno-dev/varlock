/**
 * Handling for loading with no schema (no .env files found, or files with no items defined).
 *
 * `varlock load` / `run` error in that case, but `load --format json-full` (used by
 * `varlock/auto-load` and the framework integrations) exits 0 so its JSON still reaches stdout,
 * and those callers discard the CLI's stderr on success. Without the warning below (emitted by
 * `execSyncVarlock`), an app started from the wrong directory (or from a build that dropped the
 * .env files) would boot with every value undefined and no hint why.
 */

export const ALLOW_NO_SCHEMA_ENV_VAR = '_VARLOCK_ALLOW_NO_SCHEMA';

/** true when the user explicitly opted in to running with no schema */
export function isNoSchemaAllowed(env: Record<string, string | undefined> = process.env) {
  const value = env[ALLOW_NO_SCHEMA_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

type LoadedGraphLike = {
  basePath?: string;
  sources?: Array<{ path?: string }>;
  config?: Record<string, unknown>;
  errors?: unknown;
};

/**
 * Warn (once per process) when a `load --format json-full` result has no config items.
 * Pass the parsed JSON. No-op when the load had errors (those are reported separately) or when
 * `_VARLOCK_ALLOW_NO_SCHEMA` is set.
 */
export function warnIfNoConfigLoaded(parsed: LoadedGraphLike | undefined) {
  if (!parsed || parsed.errors) return;
  if (parsed.config && Object.keys(parsed.config).length > 0) return;
  if (isNoSchemaAllowed()) return;
  if ((globalThis as any).__varlockNoSchemaWarned) return;
  (globalThis as any).__varlockNoSchemaWarned = true;

  const dir = parsed.basePath ?? process.cwd();
  const hasFiles = parsed.sources?.some((s) => s.path !== undefined);
  // eslint-disable-next-line no-console
  console.warn([
    hasFiles
      ? `⚠️  [varlock] No config items defined in ${dir}, so no env values were loaded or validated.`
      : `⚠️  [varlock] No .env files found in ${dir}, so no env values were loaded or validated.`,
    '   Run `varlock init` to create a .env.schema file, or run from the directory that contains it.',
    `   This will be an error in the next major version. Set ${ALLOW_NO_SCHEMA_ENV_VAR}=1 to allow running without a schema.`,
  ].join('\n'));
}
