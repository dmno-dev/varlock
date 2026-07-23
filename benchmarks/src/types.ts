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
  wallMsMedian: number;
  wallMsP95: number;
  rssPeakBytesMedian: number | null;
  samples: Array<Sample>;
};

export type ScenarioResult = {
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
  versions: {
    varlock: string;
    nextjsIntegration?: string;
    viteIntegration?: string;
    '@env-spec/parser'?: string;
  };
  trigger: TriggerKind;
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
  rootDir: string;
  fixturesDir: string;
  workDir: string;
  iterations: number;
  warmup: number;
  clis: Array<CliInvocation>;
  seaPath: string | null;
};
