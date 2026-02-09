import type { CiEnvInfo, EnvRecord, PlatformDefinition } from './types';
import {
  type DeploymentEnvironment, type RepoParts,
  mapToDeploymentEnvironment,
  parsePrNumber,
  parseRepoSlug,
  refToBranch,
  shortSha,
} from './normalize';
import { PLATFORMS } from './platforms';

const VALID_ENVIRONMENTS: Set<string> = new Set(
  ['development', 'preview', 'staging', 'production', 'test'],
);

function runDetect(platform: PlatformDefinition, env: EnvRecord): boolean {
  const d = platform.detect;
  if (typeof d === 'string') return !!env[d];
  return d(env);
}

function runExtractor<T>(
  platform: PlatformDefinition,
  key: keyof PlatformDefinition,
  env: EnvRecord,
): T | undefined {
  const ext = platform[key];
  if (ext === undefined) return undefined;
  if (typeof ext === 'function') return (ext as (env: EnvRecord) => T | undefined)(env);
  if (key === 'environment' && typeof ext === 'object' && ext !== null && 'var' in ext && 'map' in ext) {
    return mapToDeploymentEnvironment(env[ext.var], ext.map) as T;
  }
  const raw = env[ext as string];
  if (raw === undefined || raw === '') return undefined;
  switch (key) {
    case 'repo':
      return parseRepoSlug(raw) as T;
    case 'branch': {
      const branch = refToBranch(raw);
      return (branch ?? raw) as T;
    }
    case 'prNumber':
      return parsePrNumber(raw) as T;
    case 'commitSha':
      return raw as T;
    case 'environment':
      return VALID_ENVIRONMENTS.has(raw) ? raw as T : undefined;
    default:
      return raw as T;
  }
}

function buildRaw(
  platform: PlatformDefinition,
  env: EnvRecord,
): Record<string, string> | undefined {
  const keys = [
    'repo',
    'branch',
    'prNumber',
    'commitSha',
    'environment',
    'runId',
    'buildUrl',
    'workflowName',
    'actor',
    'eventName',
  ] as const;
  const raw: Record<string, string> = {};
  let hasAny = false;
  for (const k of keys) {
    const ext = platform[k];
    if (typeof ext === 'string' && env[ext]) {
      raw[ext] = env[ext]!;
      hasAny = true;
    }
    if (k === 'environment' && typeof ext === 'object' && ext !== null && 'var' in ext && env[ext.var]) {
      raw[ext.var] = env[ext.var]!;
      hasAny = true;
    }
  }
  return hasAny ? raw : undefined;
}

/**
 * Compute CiEnvInfo from the given env record. Uses in-package platform definitions.
 * If env.CI === 'false', returns isCI: false (escape hatch).
 */
export function getCiEnv(env: EnvRecord): CiEnvInfo {
  const e = env;

  if (e.CI === 'false') {
    return { isCI: false };
  }

  for (const platform of PLATFORMS) {
    if (!runDetect(platform, e)) continue;

    const repo = runExtractor<RepoParts>(platform, 'repo', e);
    const commitSha = runExtractor<string>(platform, 'commitSha', e);
    let isPR: boolean | undefined;
    if (platform.isPR !== undefined) {
      isPR = typeof platform.isPR === 'string' ? !!e[platform.isPR] : platform.isPR(e);
    } else {
      isPR = runExtractor<number>(platform, 'prNumber', e) !== undefined;
    }
    const info: CiEnvInfo = {
      isCI: true,
      name: platform.name,
      docsUrl: platform.docsUrl,
      isPR,
      repo,
      fullRepoName: repo ? `${repo.owner}/${repo.name}` : undefined,
      branch: runExtractor<string>(platform, 'branch', e),
      prNumber: runExtractor<number>(platform, 'prNumber', e),
      commitSha,
      commitShaShort: shortSha(commitSha),
      environment: runExtractor<DeploymentEnvironment>(platform, 'environment', e),
      runId: runExtractor<string>(platform, 'runId', e),
      buildUrl: runExtractor<string>(platform, 'buildUrl', e),
      workflowName: runExtractor<string>(platform, 'workflowName', e),
      actor: runExtractor<string>(platform, 'actor', e),
      eventName: runExtractor<string>(platform, 'eventName', e),
      raw: buildRaw(platform, e),
    };
    return info;
  }

  // Generic CI (e.g. CI=true but no vendor matched)
  const isCI = e.CI === 'true'
    || !!e.BUILD_ID
    || !!e.BUILD_NUMBER
    || !!e.CI_APP_ID
    || !!e.CI_BUILD_ID
    || !!e.CI_BUILD_NUMBER
    || !!e.CI_NAME
    || !!e.CONTINUOUS_INTEGRATION
    || !!e.RUN_ID;

  return {
    isCI: !!isCI,
  };
}

/**
 * Convenience: compute CiEnvInfo from the current process.env.
 * Equivalent to getCiEnv(process.env).
 */
export function getCiEnvFromProcess(): CiEnvInfo {
  return getCiEnv(process.env);
}
