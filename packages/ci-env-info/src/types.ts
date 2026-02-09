import type { DeploymentEnvironment, RepoParts } from './normalize';

/** Env-like object: keys are variable names, values are string or undefined (missing). */
export type EnvRecord = Record<string, string | undefined>;

export interface CiEnvInfo {
  isCI: boolean;
  name?: string;
  docsUrl?: string;
  isPR?: boolean;
  repo?: RepoParts;
  fullRepoName?: string;
  branch?: string;
  prNumber?: number;
  commitSha?: string;
  commitShaShort?: string;
  environment?: DeploymentEnvironment;
  /** Unique run/build id (e.g. GITHUB_RUN_ID, BUILD_ID) */
  runId?: string;
  /** URL to the run or deploy in the CI/deploy UI */
  buildUrl?: string;
  /** Workflow or pipeline name */
  workflowName?: string;
  /** User or app that triggered the run (e.g. GITHUB_ACTOR) */
  actor?: string;
  /** Event type (e.g. push, pull_request, workflow_dispatch) */
  eventName?: string;
  raw?: Record<string, string>;
}

export type DetectFn = (env: EnvRecord) => boolean;

/** String = env var name (truthy check); function = custom detection */
export type Detect = string | DetectFn;

/** String = env var name (value passed to default parser); function = custom extractor */
export type Extractor<T> = string | ((env: EnvRecord) => T | undefined);

/** Inline env var + value map for normalized deployment environment */
export interface EnvironmentMap {
  var: string;
  map: Record<string, DeploymentEnvironment>;
}

export interface PlatformDefinition {
  name: string;
  docsUrl?: string;
  detect: Detect;
  /** Optional: env var name (truthy = PR) or function to detect PR (else inferred from prNumber) */
  isPR?: string | DetectFn;
  repo?: Extractor<RepoParts>;
  branch?: Extractor<string>;
  prNumber?: Extractor<number>;
  commitSha?: Extractor<string>;
  /** Env var name, value map, or custom extractor */
  environment?: Extractor<DeploymentEnvironment> | EnvironmentMap;
  runId?: Extractor<string>;
  buildUrl?: Extractor<string>;
  workflowName?: Extractor<string>;
  actor?: Extractor<string>;
  eventName?: Extractor<string>;
}
