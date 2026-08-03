import {
  mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  installVarlockBun,
  installVarlockNpm,
  npmInstallDir,
  bunInstallDir,
  probeCli,
  readInstalledVersion,
  seaInvocation,
  tryNpmViewVersion,
  waitForNpmPackage,
} from './install.ts';
import { runAllScenarios, SCENARIO_GROUPS } from './scenarios/index.ts';
import { formatSummaryMarkdown } from './report.ts';
import { startTelemetryMock } from './telemetry-mock.ts';
import { ALL_TELEMETRY_MODES } from './telemetry.ts';
import type {
  BenchContext, BenchRunResult, CliInvocation, TelemetryMode, TriggerKind,
} from './types.ts';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'fixtures');
const RESULTS_DIR = join(ROOT_DIR, 'results');
const WORK_DIR = join(ROOT_DIR, '.work');

const TRIGGER_KINDS: Array<TriggerKind> = ['release', 'workflow_dispatch', 'local'];

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

function parsePositiveInt(raw: string | undefined, flag: string, { allowZero = false } = {}): number {
  const n = Number(raw);
  const min = allowZero ? 0 : 1;
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < min) {
    throw new Error(`${flag} expects an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseArgs(argv: Array<string>): Args {
  const args: Args = {
    version: 'latest',
    seaPath: null,
    out: null,
    iterations: 5,
    warmup: 1,
    only: [],
    skipInstall: false,
    trigger: 'local',
    help: false,
  };

  const envTrigger = process.env.BENCH_TRIGGER;
  if (envTrigger) {
    if (!TRIGGER_KINDS.includes(envTrigger as TriggerKind)) {
      throw new Error(`BENCH_TRIGGER must be one of ${TRIGGER_KINDS.join(', ')}, got ${JSON.stringify(envTrigger)}`);
    }
    args.trigger = envTrigger as TriggerKind;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version') args.version = argv[++i] ?? args.version;
    else if (a === '--sea-path') args.seaPath = argv[++i] ?? null;
    else if (a === '--out') args.out = argv[++i] ?? null;
    else if (a === '--iterations') args.iterations = parsePositiveInt(argv[++i], '--iterations');
    else if (a === '--warmup') args.warmup = parsePositiveInt(argv[++i], '--warmup', { allowZero: true });
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip-install') args.skipInstall = true;
    else if (a === '--trigger') {
      const value = argv[++i];
      if (!value || !TRIGGER_KINDS.includes(value as TriggerKind)) {
        throw new Error(`--trigger must be one of ${TRIGGER_KINDS.join(', ')}, got ${JSON.stringify(value)}`);
      }
      args.trigger = value as TriggerKind;
    } else throw new Error(`Unknown argument: ${a}`);
  }

  // Unknown group names used to produce an empty run that still looked successful.
  const knownGroups = SCENARIO_GROUPS.map((g) => g.name);
  const unknown = args.only.filter((name) => !knownGroups.includes(name));
  if (unknown.length > 0) {
    throw new Error(`--only got unknown scenario group(s): ${unknown.join(', ')}\nKnown groups: ${knownGroups.join(', ')}`);
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
  --trigger <kind>    ${TRIGGER_KINDS.join(' | ')}
  --help
`;
}

/** Bad flags are user error, not a crash — print the problem and the usage, no stack. */
function parseArgsOrExit(argv: Array<string>): Args {
  try {
    return parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n`);
    console.error(usage());
    process.exit(1);
  }
}

function gitSha(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT_DIR });
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultOutPath(version: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  return join(RESULTS_DIR, `${iso}-varlock@${version}-${runId}.json`);
}

/** Inspect the installed package without executing telemetry-enabled code. */
function checkTelemetryMockable(cli: CliInvocation): boolean {
  const cliScript = cli.command.find((part) => part.endsWith('/bin/cli.js'));
  if (!cliScript) return false;

  const pending = [join(dirname(dirname(cliScript)), 'dist')];
  try {
    while (pending.length > 0) {
      const dir = pending.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (/\.[cm]?js$/.test(entry.name)
          && readFileSync(path, 'utf8').includes('VARLOCK_POSTHOG_HOST')) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  // Waits when the version is not on npm yet — a release-triggered run can start
  // before the registry has caught up.
  const resolvedVersion = await waitForNpmPackage(
    args.version === 'latest' ? 'varlock@latest' : `varlock@${args.version}`,
  );

  console.log(`Benchmarking varlock@${resolvedVersion}`);
  mkdirSync(WORK_DIR, { recursive: true });

  const notes: Array<string> = [];
  const note = (message: string) => {
    notes.push(message);
    console.log(`  note: ${message}`);
  };

  const clis: Array<CliInvocation> = [];
  if (args.skipInstall) {
    const npmCli = join(npmInstallDir(WORK_DIR), 'node_modules', 'varlock', 'bin', 'cli.js');
    const bunCli = join(bunInstallDir(WORK_DIR), 'node_modules', 'varlock', 'bin', 'cli.js');
    if (!existsSync(npmCli) || !existsSync(bunCli)) {
      throw new Error('--skip-install requires existing .work/installs/{npm,bun}');
    }
    clis.push(
      { command: [process.execPath, npmCli], label: 'npm', packageManager: 'npm' },
      { command: ['bun', bunCli], label: 'bun', packageManager: 'bun' },
    );
  } else {
    console.log('Installing varlock via npm (run with node)...');
    clis.push(installVarlockNpm(WORK_DIR, resolvedVersion));
    console.log('Installing varlock via bun (run with bun)...');
    clis.push(installVarlockBun(WORK_DIR, resolvedVersion));
  }

  if (args.seaPath) {
    console.log(`Using SEA binary at ${args.seaPath}`);
    clis.push(seaInvocation(resolve(args.seaPath)));
  } else {
    note('SEA scenarios skipped: no --sea-path given');
  }

  // A CLI that cannot even print its version would fail every scenario it appears
  // in. Drop it with a recorded note rather than taking the whole suite down.
  const usableClis = clis.filter((cli) => {
    const probe = probeCli(cli);
    if (!probe.ok) {
      note(`${cli.label} install skipped: \`varlock --version\` failed (${probe.error})`);
      return false;
    }
    return true;
  });
  if (usableClis.length === 0) {
    throw new Error('No usable varlock CLI invocations — nothing to benchmark');
  }

  const telemetryMock = await startTelemetryMock();
  const telemetryMockEnv = { VARLOCK_POSTHOG_HOST: telemetryMock.url };
  let telemetryModes: Array<TelemetryMode> = ['off'];

  try {
    const mockable = checkTelemetryMockable(usableClis[0]!);
    if (mockable) {
      telemetryModes = ALL_TELEMETRY_MODES;
      console.log(`Telemetry endpoint override supported: telemetry-on scenarios enabled with ${telemetryMock.url}`);
    } else {
      note(
        `telemetry-on scenarios skipped: varlock@${resolvedVersion} does not honour VARLOCK_POSTHOG_HOST, `
        + 'and benchmarks never send real telemetry',
      );
    }

    const ctx: BenchContext = {
      version: resolvedVersion,
      integrationVersions: {
        nextjs: tryNpmViewVersion('@varlock/nextjs-integration'),
        vite: tryNpmViewVersion('@varlock/vite-integration'),
      },
      rootDir: ROOT_DIR,
      fixturesDir: FIXTURES_DIR,
      workDir: WORK_DIR,
      iterations: args.iterations,
      warmup: args.warmup,
      clis: usableClis,
      seaPath: args.seaPath,
      telemetryModes,
      telemetryMockEnv: telemetryModes.includes('on') ? telemetryMockEnv : {},
      // Enables the on-disk resolver cache even in CI, where varlock otherwise
      // falls back to a per-process memory cache that cannot survive between
      // invocations — which would make the warm-load scenario measure nothing.
      cacheKey: randomBytes(32).toString('hex'),
      note,
    };

    const scenarios = await runAllScenarios(ctx, args.only.length ? args.only : undefined);

    const result: BenchRunResult = {
      meta: {
        timestamp: new Date().toISOString(),
        gitSha: gitSha(),
        githubRunId: process.env.GITHUB_RUN_ID ?? null,
        runnerOs: process.platform,
        runnerArch: process.arch,
        nodeVersion: process.version,
        versions: {
          varlock: resolvedVersion,
          nextjsIntegration: ctx.integrationVersions.nextjs,
          viteIntegration: ctx.integrationVersions.vite,
          '@env-spec/parser': readInstalledVersion(npmInstallDir(WORK_DIR), '@env-spec/parser') ?? undefined,
        },
        trigger: args.trigger,
        telemetryMocked: telemetryModes.includes('on'),
        notes,
      },
      scenarios,
    };

    const outPath = args.out ? resolve(args.out) : defaultOutPath(resolvedVersion);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);

    const summary = formatSummaryMarkdown(result);
    console.log(`\n${summary}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    }

    // Also write a pointer file used by CI commit step
    writeFileSync(join(WORK_DIR, 'last-result-path.txt'), `${outPath}\n`);
  } finally {
    await telemetryMock.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
