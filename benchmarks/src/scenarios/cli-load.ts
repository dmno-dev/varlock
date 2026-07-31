import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';
import { cliScenarioId, fixtureWorkDir } from './util.ts';

export async function runCliLoadScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const cwd = fixtureWorkDir(ctx, 'cli-basic', '-load');
  const results: Array<ScenarioResult> = [];

  for (const cli of ctx.clis) {
    for (const telemetry of ctx.telemetryModes) {
      // _VARLOCK_CACHE_KEY forces the on-disk resolver cache. Without it, CI falls
      // back to an in-process memory cache (see loader.ts cache policy), which
      // cannot survive between CLI invocations — so "warm" would silently measure
      // exactly the same work as "cold".
      const env = {
        ...telemetryEnv(telemetry, ctx.telemetryMockEnv),
        _VARLOCK_CACHE_KEY: ctx.cacheKey,
      };

      const cold = await repeatMeasure(
        async () => measureCommand([...cli.command, 'load', '--clear-cache'], { cwd, env }),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: cliScenarioId(`cli.load.cold.telemetry.${telemetry}`, cli),
        facet: 'cli-load',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: cold,
        notes: 'Disk cache cleared before every iteration',
      });

      // Warm: one clear then repeated loads without clear
      await measureCommand([...cli.command, 'load', '--clear-cache'], { cwd, env });
      const warm = await repeatMeasure(
        async () => measureCommand([...cli.command, 'load'], { cwd, env }),
        { iterations: ctx.iterations, warmup: ctx.warmup },
      );
      results.push({
        id: cliScenarioId(`cli.load.warm.telemetry.${telemetry}`, cli),
        facet: 'cli-load',
        installMethod: cli.label,
        packageManager: cli.packageManager,
        telemetry,
        metrics: warm,
        notes: 'Disk cache populated (_VARLOCK_CACHE_KEY set)',
      });
    }
  }

  return results;
}
