/**
 * Well-known environment variables injected by the operating system, shell, language
 * runtime, package managers, and CI / hosting providers. They are routinely read from
 * `process.env` in real application and tooling code, but are never declared in a varlock
 * schema - so `varlock audit` should not flag them as "missing in schema", and
 * `varlock init` should not add them to a freshly inferred schema.
 *
 * The list is intentionally conservative: it only contains unambiguous platform markers
 * (paths, flags, runtime hints, CI context). It deliberately excludes anything that could
 * plausibly be application config or a secret - e.g. `PORT`, `HOST`, `DATABASE_URL`, or
 * any `*_TOKEN` / `*_KEY` / `*_SECRET`. In particular we do NOT prefix-match `GITHUB_`,
 * since user-defined secrets are commonly named that way; only the documented, non-secret
 * GitHub Actions context vars are listed individually below.
 *
 * If one of these genuinely IS part of your config, declare it in your schema - audit only
 * skips it when it is otherwise undeclared.
 */
const WELL_KNOWN_ENV_KEYS = new Set<string>([
  // --- CI detection (generic + common providers) ---
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'APPVEYOR',
  'BUILDKITE',
  'DRONE',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'SEMAPHORE',
  'CODEBUILD_BUILD_ID',

  // --- GitHub Actions default context vars (auto-injected, non-secret) ---
  'GITHUB_ACTION',
  'GITHUB_ACTION_PATH',
  'GITHUB_ACTION_REPOSITORY',
  'GITHUB_ACTOR',
  'GITHUB_ACTOR_ID',
  'GITHUB_API_URL',
  'GITHUB_BASE_REF',
  'GITHUB_ENV',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_HEAD_REF',
  'GITHUB_JOB',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_PROTECTED',
  'GITHUB_REF_TYPE',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_RETENTION_DAYS',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'GITHUB_WORKSPACE',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'RUNNER_NAME',
  'RUNNER_TEMP',
  'RUNNER_TOOL_CACHE',
  'RUNNER_DEBUG',
  'RUNNER_ENVIRONMENT',
  'RUNNER_WORKSPACE',

  // --- hosting / serverless platform detection ---
  'VERCEL',
  'NETLIFY',
  'CF_PAGES',
  'WORKERS_CI',
  'RENDER',

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

  // --- language runtime ---
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_DEBUG',
  'NODE_EXTRA_CA_CERTS',
  'NODE_NO_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',

  // --- output / TTY ---
  'NO_COLOR',
  'FORCE_COLOR',
  'COLORTERM',
  'DEBUG',
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
 * Returns true if `key` is a well-known platform/runtime/CI variable that should be
 * excluded from audit drift reporting and from inferred schemas. Matching is
 * case-insensitive (handles e.g. `comspec` vs `ComSpec`).
 */
export function isWellKnownEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (WELL_KNOWN_ENV_KEYS.has(upper)) return true;
  return WELL_KNOWN_ENV_KEY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
