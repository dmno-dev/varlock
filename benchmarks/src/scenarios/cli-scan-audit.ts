import { join } from 'node:path';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';

export async function runCliScanAuditScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  const cwd = join(ctx.fixturesDir, 'cli-basic');
  const results: Array<ScenarioResult> = [];
  const env = telemetryEnv('off');

  // Lighter coverage: fewer iterations than load/run
  const lightIterations = Math.max(2, Math.min(3, ctx.iterations));
  const lightWarmup = Math.min(1, ctx.warmup);

  for (const cli of ctx.clis) {
    const scan = await repeatMeasure(
      async () => measureCommand([...cli.command, 'scan', './child.js'], {
        cwd,
        env,
        timeoutMs: 180_000,
      }),
      { iterations: lightIterations, warmup: lightWarmup },
    );
    results.push({
      id: 'cli.scan',
      facet: 'cli-scan',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: scan,
      notes: 'scan of a clean file (load + scan cost)',
    });

    const audit = await repeatMeasure(
      async () => measureCommand([...cli.command, 'audit', '.'], {
        cwd,
        env,
        timeoutMs: 180_000,
      }),
      { iterations: lightIterations, warmup: lightWarmup },
    );
    results.push({
      id: 'cli.audit',
      facet: 'cli-audit',
      installMethod: cli.label,
      packageManager: cli.packageManager,
      telemetry: 'off',
      metrics: audit,
    });
  }

  return results;
}
