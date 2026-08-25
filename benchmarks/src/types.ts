/**
 * How the measured CLI was installed and invoked:
 * - `npm`  — installed with npm, run with node
 * - `bun`  — installed with bun, run with the bun runtime
 * - `sea`  — the standalone compiled binary
 */
export type InstallMethod = 'npm' | 'bun' | 'sea';

export type TelemetryMode = 'on' | 'off';

export type ScenarioFacet = | 'cli-load'
  | 'cli-run'
  | 'cli-scan'
  | 'cli-audit'
  | 'integration-next'
  | 'integration-vite'
  | 'lang-python'
  | 'lang-go';

export type TriggerKind = 'release' | 'workflow_dispatch' | 'local';

export type Sample = {
  wallMs: number;
  rssPeakBytes: number | null;
  exitCode: number;
};

export type ScenarioMetrics = {
  /** Number of measured (non-warmup) iterations behind these numbers. */
  iterations: number;
  wallMsMin: number;
  wallMsMedian: number;
  /** Collapses onto the max at low iteration counts — read with wallMsStdDev. */
  wallMsP95: number;
  wallMsStdDev: number;
  rssPeakBytesMedian: number | null;
  /** How many iterations produced an RSS reading (0 means RSS was never sampled). */
  rssSampleCount: number;
  samples: Array<Sample>;
};

export type ScenarioResult = {
  /** Unique within a run — includes the install method for CLI scenarios. */
  id: string;
  facet: ScenarioFacet;
  installMethod: InstallMethod;
  packageManager?: 'npm' | 'bun';
  /** Whether VARLOCK_TELEMETRY_DISABLED was cleared (on) or set (off). */
  telemetry: TelemetryMode;
  metrics: ScenarioMetrics;
  notes?: string;
};

export type BenchRunMeta = {
  timestamp: string;
  gitSha: string | null;
  githubRunId: string | null;
  runnerOs: string;
  runnerArch: string;
  nodeVersion: string;
  versions: {
    varlock: string;
    nextjsIntegration?: string;
    viteIntegration?: string;
    '@env-spec/parser'?: string;
  };
  trigger: TriggerKind;
  /**
   * True when telemetry-on scenarios were pointed at a local mock collector.
   * When false those scenarios are skipped — benchmarks never emit real telemetry.
   */
  telemetryMocked: boolean;
  /** Anything skipped, degraded, or otherwise worth knowing when reading the numbers. */
  notes: Array<string>;
};

export type BenchRunResult = {
  meta: BenchRunMeta;
  scenarios: Array<ScenarioResult>;
};

export type CliInvocation = {
  /** Executable + args that invoke varlock (without the subcommand). */
  command: Array<string>;
  label: InstallMethod;
  packageManager?: 'npm' | 'bun';
};

export type BenchContext = {
  version: string;
  /**
   * Resolved (not floating) integration versions, so a run records the exact pair
   * of packages it measured.
   */
  integrationVersions: {
    nextjs?: string;
    vite?: string;
  };
  rootDir: string;
  fixturesDir: string;
  workDir: string;
  iterations: number;
  warmup: number;
  clis: Array<CliInvocation>;
  seaPath: string | null;
  /** Telemetry modes to measure — 'on' is dropped when the mock is unavailable. */
  telemetryModes: Array<TelemetryMode>;
  /** Env overlay that points telemetry at the local mock (empty when unavailable). */
  telemetryMockEnv: Record<string, string>;
  /** 64-char hex key that enables the on-disk resolver cache, including in CI. */
  cacheKey: string;
  /** Record a skip / degradation so it shows up in the committed results. */
  note: (message: string) => void;
};
