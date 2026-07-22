import { join } from 'node:path';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { TELEMETRY_MODES, telemetryEnv } from '../telemetry.ts';

export async function runCliLoadScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const cwd = join(ctx.fixturesDir, 'cli-basic');
  const results: Array<ScenarioResult> = [];

  for (const cli of ctx.clis) {
    for (const telemetry of TELEMETRY_MODES) {
      const env = telemetryEnv(telemetry);

      const cold = await repeatMeasure(
        async () => measureCommand([...cli.command, 'load', '--clear-cache'], { cwd, env }),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: `cli.load.cold.telemetry.${telemetry}`,
        facet: 'cli-load',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: cold,
      });

      // Warm: one clear then repeated loads without clear
      await measureCommand([...cli.command, 'load', '--clear-cache'], { cwd, env });
      const warm = await repeatMeasure(
        async () => measureCommand([...cli.command, 'load'], { cwd, env }),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: `cli.load.warm.telemetry.${telemetry}`,
        facet: 'cli-load',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: warm,
      });
    }
  }

  return results;
}
