/**
 * Single source of truth for varlock's reserved environment variables.
 *
 * Naming convention:
 * - `VARLOCK_*`  (no underscore)     — user-facing builtin/computed vars (see builtin-vars.ts)
 * - `_VARLOCK_*` (single underscore) — vars users may set to configure varlock's own behavior
 * - `__VARLOCK_*` (double underscore) — internal markers varlock injects; never set by users
 *
 * Keep this list in sync with the docs reference page (reference/reserved-variables).
 */

/**
 * Prefix reserved for env vars that configure varlock's own behavior. Keys with this prefix
 * are excluded from the injected env blob, generated types, and override provenance — even
 * if a user happens to define one in their schema.
 */
export const VARLOCK_RESERVED_KEY_PREFIX = '_VARLOCK_';

/**
 * The `.env` files varlock reads its own `_VARLOCK_*` config from. Only these are scanned —
 * not the committed `.env.schema`, nor env-specific files like `.env.production` — so this
 * config stays in the local/value files where it belongs.
 */
export const VARLOCK_CONFIG_VAR_FILENAMES = new Set(['.env', '.env.local']);

export type ReservedVarInfo = {
  name: string;
  description: string;
  /** internal vars are implementation details not meant to be set by end users */
  internal?: boolean;
};

/** Vars users may set to configure varlock's behavior (`_VARLOCK_*`). */
export const VARLOCK_CONFIG_ENV_VARS: Array<ReservedVarInfo> = [
  {
    name: '_VARLOCK_ENV_KEY',
    description: 'Encryption key used to decrypt the injected env blob and any `encrypted()` values at runtime. Typically set in deploy environments.',
  },
  {
    name: '_VARLOCK_CACHE_KEY',
    description: 'Encryption key for the on-disk resolved-value cache. When set (e.g. as a CI secret), it enables the disk cache in environments without OS keychain access.',
  },
  {
    name: '_VARLOCK_REDACT_STDOUT',
    description: 'Overrides `varlock run` output redaction. `true`/`1` forces redaction on, `false`/`0` forces it off. The `--redact-stdout` / `--no-redact-stdout` flags take precedence.',
  },
  {
    name: '_VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK',
    description: 'Forces the file-based local encryption fallback instead of the native binary. Intended for testing/debugging.',
    internal: true,
  },
];

/** Internal markers varlock injects into the child/runtime env (`__VARLOCK_*`). Not user-settable. */
export const VARLOCK_INTERNAL_ENV_VARS: Array<ReservedVarInfo> = [
  {
    name: '__VARLOCK_ENV',
    description: 'The serialized env graph (config values + metadata) injected by `varlock run` and build-time integrations so the runtime can load without re-invoking the CLI.',
    internal: true,
  },
  {
    name: '__VARLOCK_RUN',
    description: 'Marker set so a child process can detect it is running under `varlock run`.',
    internal: true,
  },
];

/**
 * Check if a config item key is reserved for varlock infrastructure. These keys are never
 * exposed via the ENV proxy, serialized into the injected env blob, included in generated
 * types, or recorded as override provenance — even if a user defines one in their schema.
 */
export function isVarlockReservedKey(key: string): boolean {
  return key.startsWith(VARLOCK_RESERVED_KEY_PREFIX);
}

const VARLOCK_CONFIG_VARS_BY_NAME = new Map(VARLOCK_CONFIG_ENV_VARS.map((v) => [v.name, v]));

/**
 * Check if a key is a recognized `_VARLOCK_*` config var (e.g. `_VARLOCK_ENV_KEY`). An
 * unrecognized `_VARLOCK_*` key is almost certainly a typo.
 */
export function isKnownVarlockConfigVar(key: string): boolean {
  return VARLOCK_CONFIG_VARS_BY_NAME.has(key);
}

/**
 * Whether a `_VARLOCK_*` config var can be honored when set as a static value in a `.env`
 * file (extracted before/around graph resolution and used to configure varlock itself).
 * Internal vars (e.g. `_VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK`) are read from the real
 * environment at module load, too early to source from a file, so they're excluded.
 */
export function isFileHonorableVarlockConfigVar(key: string): boolean {
  const info = VARLOCK_CONFIG_VARS_BY_NAME.get(key);
  return !!info && !info.internal;
}

/**
 * The single precedence rule for varlock's own config: a real environment variable wins
 * over a value picked up from a `.env` file. Returns a merged env record (env layered over
 * file values) — use this anywhere a `_VARLOCK_*` setting is read.
 */
export function mergeVarlockConfigEnv(
  fileVars: Record<string, string | undefined> = {},
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...fileVars, ...env };
}
