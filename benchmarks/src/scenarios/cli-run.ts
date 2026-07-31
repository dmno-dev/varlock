import { join } from 'node:path';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';
import { cliScenarioId, fixtureWorkDir } from './util.ts';

/**
 * Output volume for the redaction benches.
 *
 * Redaction cost is per byte of stdout, while everything around it (process
 * spawn, varlock load, node startup) is a fixed ~50ms. At a few hundred lines the
 * on/off delta sits well inside run-to-run noise on a shared runner, so the
 * scenario cannot answer the question it exists to answer. ~3MB of output puts
 * the redaction work above the noise floor.
 */
const REDACT_BENCH_LINES = 50_000;

export async function runCliRunScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const cwd = fixtureWorkDir(ctx, 'cli-basic', '-run');
  const childJs = join(cwd, 'child.js');
  const emitJs = join(cwd, 'emit-secret.js');
  const results: Array<ScenarioResult> = [];

  // Bare node baseline (no varlock in the picture; installMethod is not meaningful here)
  const bare = await repeatMeasure(
    async () => measureCommand([process.execPath, childJs], { cwd }),
    { iterations: ctx.iterations, warmup: ctx.warmup },
  );
  results.push({
    id: 'cli.run.bare-node',
    facet: 'cli-run',
    installMethod: 'npm',
    packageManager: 'npm',
    telemetry: 'off',
    metrics: bare,
    notes: 'Baseline without varlock wrap — subtract from cli.run.wrap.* for wrap overhead',
  });

  for (const cli of ctx.clis) {
    // Wrap overhead measured with telemetry on/off (exit-hook wait hits here)
    for (const telemetry of ctx.telemetryModes) {
      const env = telemetryEnv(telemetry, ctx.telemetryMockEnv);
      const wrapped = await repeatMeasure(
        async () => measureCommand(
          [...cli.command, 'run', '--', process.execPath, childJs],
          { cwd, env },
        ),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: cliScenarioId(`cli.run.wrap.telemetry.${telemetry}`, cli),
        facet: 'cli-run',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: wrapped,
        notes: 'varlock run wrap overhead vs bare-node',
      });
    }

    // Redaction comparison: telemetry off so we isolate redact-stdout cost
    const envOff = {
      ...telemetryEnv('off'),
      BENCH_EMIT_LINES: String(REDACT_BENCH_LINES),
    };
    // These scenarios deliberately print (fixture) secret values, so failure output
    // is truncated hard rather than dumped into CI logs.
    const redactRepeatOpts = {
      iterations: ctx.iterations,
      warmup: Math.max(1, ctx.warmup),
      maxFailureOutputChars: 500,
    };

    const redactOn = await repeatMeasure(
      async () => measureCommand(
        [...cli.command, 'run', '--redact-stdout', '--', process.execPath, emitJs],
        { cwd, env: envOff, timeoutMs: 300_000 },
      ),
      redactRepeatOpts,
    );
    results.push({
      id: cliScenarioId('cli.run.redact-stdout.on', cli),
      facet: 'cli-run',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: redactOn,
      notes: `${REDACT_BENCH_LINES} stdout lines containing secrets`,
    });

    const redactOff = await repeatMeasure(
      async () => measureCommand(
        [...cli.command, 'run', '--no-redact-stdout', '--', process.execPath, emitJs],
        { cwd, env: envOff, timeoutMs: 300_000 },
      ),
      redactRepeatOpts,
    );
    results.push({
      id: cliScenarioId('cli.run.redact-stdout.off', cli),
      facet: 'cli-run',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: redactOff,
      notes: `${REDACT_BENCH_LINES} stdout lines containing secrets`,
    });
  }

  return results;
}
