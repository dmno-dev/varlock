import { type CiEnvInfo, type DeploymentEnvironment } from '@varlock/ci-env-info';

export type BuiltinVarDef = {
  name: string;
  description: string;
  resolver: (ciEnv: CiEnvInfo, processEnv: Record<string, string | undefined>) => string | undefined;
};

/**
 * Detect if we're running in a test environment.
 * This check runs first, even before CI detection.
 */
function detectTestEnvironment(env: Record<string, string | undefined>): boolean {
  return !!(
    env.NODE_ENV === 'test'
    || env.JEST_WORKER_ID
    || env.VITEST
    || env.VITEST_POOL_ID
  );
}

/**
 * Infer deployment environment from branch name.
 * Used when CI is detected but platform doesn't provide explicit environment.
 */
function inferFromBranch(branch: string): DeploymentEnvironment {
  const lower = branch.toLowerCase();
  if (['main', 'master', 'production', 'prod'].includes(lower)) return 'production';
  if (['staging', 'stage', 'develop', 'dev'].includes(lower)) return 'staging';
  if (['qa', 'test'].includes(lower)) return 'test';
  return 'preview';
}

/**
 * Multi-tier environment detection strategy:
 * 1. Test environment detection (NODE_ENV=test, JEST_WORKER_ID, VITEST, etc.)
 * 2. Platform-provided environment (Vercel VERCEL_ENV, Netlify CONTEXT)
 * 3. Branch name inference (main/master→production, staging/develop→staging, others→preview)
 * 4. deployed in CI → preview
 * 5. not CI, default to development
 */
function inferVarlockEnv(ciEnv: CiEnvInfo, processEnv: Record<string, string | undefined>): DeploymentEnvironment {
  // Tier 1: Test detection (runs first, even in CI)
  if (detectTestEnvironment(processEnv)) return 'test';

  // Tier 2: Platform-provided (Vercel, Netlify, etc.)
  if (ciEnv.environment) return ciEnv.environment;

  // Tier 3: Branch inference (when in CI with branch info)
  if (ciEnv.isCI && ciEnv.branch) return inferFromBranch(ciEnv.branch);

  // Tier 4: deployed in CI = preview
  if (ciEnv.isCI) return 'preview';

  // Tier 5: not CI, default to development
  return 'development';
}

export const BUILTIN_VARS: Record<string, BuiltinVarDef> = {
  VARLOCK_ENV: {
    name: 'VARLOCK_ENV',
    description: 'Auto-detected deployment environment (development, preview, staging, production, test)',
    resolver: (ciEnv, processEnv) => inferVarlockEnv(ciEnv, processEnv),
  },
  VARLOCK_IS_CI: {
    name: 'VARLOCK_IS_CI',
    description: 'Whether running in a CI environment ("true" or "false")',
    resolver: (ciEnv) => (ciEnv.isCI ? 'true' : 'false'),
  },
  VARLOCK_BRANCH: {
    name: 'VARLOCK_BRANCH',
    description: 'Current git branch name',
    resolver: (ciEnv) => ciEnv.branch,
  },
  VARLOCK_PR_NUMBER: {
    name: 'VARLOCK_PR_NUMBER',
    description: 'Pull request number if in PR context',
    resolver: (ciEnv) => ciEnv.prNumber?.toString(),
  },
  VARLOCK_COMMIT_SHA: {
    name: 'VARLOCK_COMMIT_SHA',
    description: 'Full commit SHA',
    resolver: (ciEnv) => ciEnv.commitSha,
  },
  VARLOCK_COMMIT_SHA_SHORT: {
    name: 'VARLOCK_COMMIT_SHA_SHORT',
    description: 'Short (7-char) commit SHA',
    resolver: (ciEnv) => ciEnv.commitShaShort,
  },
  VARLOCK_PLATFORM: {
    name: 'VARLOCK_PLATFORM',
    description: 'CI platform name (e.g., "GitHub Actions", "Vercel")',
    resolver: (ciEnv) => ciEnv.name,
  },
  VARLOCK_BUILD_URL: {
    name: 'VARLOCK_BUILD_URL',
    description: 'Link to the CI build/deploy',
    resolver: (ciEnv) => ciEnv.buildUrl,
  },
  VARLOCK_REPO: {
    name: 'VARLOCK_REPO',
    description: 'Repository name in owner/repo format',
    resolver: (ciEnv) => ciEnv.fullRepoName,
  },
};

/**
 * Check if a key is a builtin VARLOCK_* variable.
 */
export function isBuiltinVar(key: string): boolean {
  return key in BUILTIN_VARS;
}
