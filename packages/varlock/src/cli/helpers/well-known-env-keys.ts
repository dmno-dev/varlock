/**
 * Environment variables that are pure *execution-environment plumbing* — an artifact of
 * where/how the process was launched (operating system, shell, node runtime flags, package
 * manager lifecycle). They are routinely read from `process.env` but are never something an
 * application author declares as config, so `varlock audit` should not flag them as "missing
 * in schema" and `varlock init` should not add them to a freshly inferred schema.
 *
 * This list is intentionally NARROW. It deliberately does NOT include semantically
 * meaningful variables that an app or its CI may legitimately depend on and may want to
 * track — e.g. `NODE_ENV`, the `CI` flag, GitHub Actions / GitLab context vars, or
 * hosting-platform markers like `VERCEL`. Those should keep showing up in audit so you can
 * decide whether to declare them (or suppress them with `@auditIgnore`).
 */
const WELL_KNOWN_ENV_KEYS = new Set<string>([
  // --- OS / shell ---
  'PATH',
  'PATHEXT',
  'HOME',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'SHLVL',
  'TERM',
  'TERM_PROGRAM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'HOSTNAME',
  'COLUMNS',
  'LINES',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'DISPLAY',
  'COMSPEC',
  'WINDIR',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',

  // --- node.js launch flags (NOT NODE_ENV - that's an app-level mode worth declaring) ---
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_DEBUG',
  'NODE_EXTRA_CA_CERTS',
  'NODE_NO_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',

  // --- terminal / color output ---
  'NO_COLOR',
  'FORCE_COLOR',
  'COLORTERM',
].map((key) => key.toUpperCase()));

/**
 * Prefixes for families of injected vars. Kept extremely narrow - only families that are
 * exclusively set by tooling and never by an application author.
 */
const WELL_KNOWN_ENV_KEY_PREFIXES = [
  // npm / yarn / pnpm / bun lifecycle: npm_config_*, npm_package_*, npm_lifecycle_*
  'NPM_',
];

/**
 * Returns true if `key` is pure execution-environment plumbing that should be excluded from
 * audit drift reporting and from inferred schemas. Matching is case-insensitive (handles
 * e.g. `comspec` vs `ComSpec`).
 */
export function isWellKnownEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (WELL_KNOWN_ENV_KEYS.has(upper)) return true;
  return WELL_KNOWN_ENV_KEY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
