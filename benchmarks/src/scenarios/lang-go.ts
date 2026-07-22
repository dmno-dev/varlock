import {
  cpSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';

function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['version'], { encoding: 'utf8' });
  return result.status === 0;
}

export async function runGoScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  if (!hasBinary('go')) {
    console.log('  skipping go: go not found');
    return [];
  }

  const results: Array<ScenarioResult> = [];
  const cli = ctx.clis.find((c) => c.label === 'npm') ?? ctx.clis[0];
  if (!cli) return [];
  const env = telemetryEnv('off');

  const dest = join(ctx.workDir, 'lang-go');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(ctx.fixturesDir, 'lang-go'), dest, { recursive: true });

  const codegen = await repeatMeasure(
    async () => {
      const genDir = join(dest, 'env');
      if (existsSync(genDir)) {
        rmSync(genDir, { recursive: true, force: true });
      }
      return measureCommand([...cli.command, 'load', '--clear-cache'], { cwd: dest, env });
    },
    { iterations: ctx.iterations, warmup: ctx.warmup },
  );
  results.push({
    id: 'lang.go.load-codegen',
    facet: 'lang-go',
    installMethod: cli.label,
    packageManager: cli.packageManager,
    telemetry: 'off',
    metrics: codegen,
    notes: 'load triggers @generateGoEnv',
  });

  await measureCommand([...cli.command, 'load'], { cwd: dest, env });

  // Build once so `go run` is not dominated by compile in every sample
  const build = spawnSync('go', ['build', '-o', 'main.bin', '.'], {
    cwd: dest,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`go build failed:\n${build.stderr}\n${build.stdout}`);
  }

  const wrapped = await repeatMeasure(
    async () => measureCommand([...cli.command, 'run', '--', join(dest, 'main.bin')], { cwd: dest, env }),
    { iterations: ctx.iterations, warmup: ctx.warmup },
  );
  results.push({
    id: 'lang.go.run',
    facet: 'lang-go',
    installMethod: cli.label,
    packageManager: cli.packageManager,
    telemetry: 'off',
    metrics: wrapped,
  });

  return results;
}
