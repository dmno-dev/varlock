import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  installVarlockBun,
  installVarlockNpm,
  npmViewVersion,
  readInstalledVersion,
  seaInvocation,
} from './install.ts';
import { runAllScenarios, SCENARIO_GROUPS } from './scenarios/index.ts';
import { formatSummaryMarkdown } from './report.ts';
import type { BenchContext, BenchRunResult, TriggerKind } from './types.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'fixtures');
const RESULTS_DIR = join(ROOT_DIR, 'results');
const WORK_DIR = join(ROOT_DIR, '.work');

type Args = {
  version: string;
  seaPath: string | null;
  out: string | null;
  iterations: number;
  warmup: number;
  only: Array<string>;
  skipInstall: boolean;
  trigger: TriggerKind;
  help: boolean;
};

function parseArgs(argv: Array<string>): Args {
  const args: Args = {
    version: 'latest',
    seaPath: null,
    out: null,
    iterations: 5,
    warmup: 1,
    only: [],
    skipInstall: false,
    trigger: (process.env.BENCH_TRIGGER as TriggerKind | undefined) ?? 'local',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version') args.version = argv[++i] ?? args.version;
    else if (a === '--sea-path') args.seaPath = argv[++i] ?? null;
    else if (a === '--out') args.out = argv[++i] ?? null;
    else if (a === '--iterations') args.iterations = Number(argv[++i]);
    else if (a === '--warmup') args.warmup = Number(argv[++i]);
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--skip-install') args.skipInstall = true;
    else if (a === '--trigger') args.trigger = (argv[++i] as TriggerKind) ?? args.trigger;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage(): string {
  const groups = SCENARIO_GROUPS.map((g) => g.name).join(', ');
  return `Usage: bun run src/run.ts [options]

Options:
  --version <ver>     Published varlock version (default: latest)
  --sea-path <path>   Path to SEA binary (enables sea install method)
  --out <path>        Output JSON path (default: results/<iso>-varlock@<ver>-<id>.json)
  --iterations <n>    Measured iterations (default: 5)
  --warmup <n>        Warmup iterations (default: 1)
  --only <groups>     Comma-separated scenario groups: ${groups}
  --skip-install      Reuse .work/installs from a previous run
  --trigger <kind>    release | workflow_dispatch | local
  --help
`;
}

function gitSha(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT_DIR });
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultOutPath(version: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  mkdirSync(RESULTS_DIR, { recursive: true });
  return join(RESULTS_DIR, `${iso}-varlock@${version}-${runId}.json`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const resolvedVersion = args.version === 'latest'
    ? npmViewVersion('varlock')
    : args.version;

  console.log(`Benchmarking varlock@${resolvedVersion}`);
  mkdirSync(WORK_DIR, { recursive: true });

  const clis = [];
  if (args.skipInstall) {
    const npmCli = join(WORK_DIR, 'installs', 'npm', 'node_modules', 'varlock', 'bin', 'cli.js');
    const bunCli = join(WORK_DIR, 'installs', 'bun', 'node_modules', 'varlock', 'bin', 'cli.js');
    if (!existsSync(npmCli) || !existsSync(bunCli)) {
      throw new Error('--skip-install requires existing .work/installs/{npm,bun}');
    }
    clis.push(
      { command: [process.execPath, npmCli], label: 'npm' as const, packageManager: 'npm' as const },
      { command: [process.execPath, bunCli], label: 'bun' as const, packageManager: 'bun' as const },
    );
  } else {
    console.log('Installing varlock via npm...');
    clis.push(installVarlockNpm(WORK_DIR, resolvedVersion));
    console.log('Installing varlock via bun...');
    clis.push(installVarlockBun(WORK_DIR, resolvedVersion));
  }

  if (args.seaPath) {
    console.log(`Using SEA binary at ${args.seaPath}`);
    clis.push(seaInvocation(resolve(args.seaPath)));
  } else {
    console.log('No --sea-path; skipping SEA scenarios');
  }

  const ctx: BenchContext = {
    version: resolvedVersion,
    rootDir: ROOT_DIR,
    fixturesDir: FIXTURES_DIR,
    workDir: WORK_DIR,
    iterations: args.iterations,
    warmup: args.warmup,
    clis,
    seaPath: args.seaPath,
  };

  const scenarios = await runAllScenarios(ctx, args.only.length ? args.only : undefined);

  const npmRoot = join(WORK_DIR, 'installs', 'npm');
  const result: BenchRunResult = {
    meta: {
      timestamp: new Date().toISOString(),
      gitSha: gitSha(),
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      runnerOs: process.platform,
      runnerArch: process.arch,
      versions: {
        varlock: resolvedVersion,
        nextjsIntegration: (() => {
          try {
            return npmViewVersion('@varlock/nextjs-integration');
          } catch {
            return undefined;
          }
        })(),
        viteIntegration: (() => {
          try {
            return npmViewVersion('@varlock/vite-integration');
          } catch {
            return undefined;
          }
        })(),
        '@env-spec/parser': readInstalledVersion(npmRoot, '@env-spec/parser') ?? undefined,
      },
      trigger: args.trigger,
    },
    scenarios,
  };

  const outPath = args.out ? resolve(args.out) : defaultOutPath(resolvedVersion);
  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);

  const summary = formatSummaryMarkdown(result);
  console.log(`\n${summary}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }

  // Also write a pointer file used by CI commit step
  writeFileSync(join(WORK_DIR, 'last-result-path.txt'), `${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
