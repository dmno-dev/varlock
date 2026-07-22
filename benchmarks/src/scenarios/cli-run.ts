import { join } from 'node:path';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { TELEMETRY_MODES, telemetryEnv } from '../telemetry.ts';

export async function runCliRunScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const cwd = join(ctx.fixturesDir, 'cli-basic');
  const childJs = join(cwd, 'child.js');
  const emitJs = join(cwd, 'emit-secret.js');
  const results: Array<ScenarioResult> = [];

  // Bare node baseline (not tied to an install method; recorded once under npm label)
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
    notes: 'Baseline without varlock wrap',
  });

  for (const cli of ctx.clis) {
    // Wrap overhead measured with telemetry on/off (exit-hook wait hits here)
    for (const telemetry of TELEMETRY_MODES) {
      const env = telemetryEnv(telemetry);
      const wrapped = await repeatMeasure(
        async () => measureCommand(
          [...cli.command, 'run', '--', process.execPath, childJs],
          { cwd, env },
        ),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: `cli.run.wrap.telemetry.${telemetry}`,
        facet: 'cli-run',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: wrapped,
        notes: 'varlock run wrap overhead vs bare-node',
      });
    }

    // Redaction comparison: telemetry off so we isolate redact-stdout cost
    const envOff = telemetryEnv('off');
    const redactOn = await repeatMeasure(
      async () => measureCommand(
        [...cli.command, 'run', '--redact-stdout', '--', process.execPath, emitJs],
        { cwd, env: envOff },
      ),
      { iterations: ctx.iterations, warmup: Math.max(1, ctx.warmup) },
    );
    results.push({
      id: 'cli.run.redact-stdout.on',
      facet: 'cli-run',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: redactOn,
    });

    const redactOff = await repeatMeasure(
      async () => measureCommand(
        [...cli.command, 'run', '--no-redact-stdout', '--', process.execPath, emitJs],
        { cwd, env: envOff },
      ),
      { iterations: ctx.iterations, warmup: Math.max(1, ctx.warmup) },
    );
    results.push({
      id: 'cli.run.redact-stdout.off',
      facet: 'cli-run',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: redactOff,
    });
  }

  return results;
}
