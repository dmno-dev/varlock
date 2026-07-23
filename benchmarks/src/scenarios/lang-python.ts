import {
  cpSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BenchContext, ScenarioResult } from '../types.ts';
import { measureCommand, repeatMeasure } from '../measure.ts';
import { telemetryEnv } from '../telemetry.ts';

function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export async function runPythonScenarios(ctx: BenchContext): Promise<Array<ScenarioResult>> {
  if (!hasBinary('python3')) {
    console.log('  skipping python: python3 not found');
    return [];
  }

  const results: Array<ScenarioResult> = [];
  // Use npm-installed CLI for lang scenarios (one representative install method)
  const cli = ctx.clis.find((c) => c.label === 'npm') ?? ctx.clis[0];
  if (!cli) return [];
  const env = telemetryEnv('off');

  const dest = join(ctx.workDir, 'lang-python');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(ctx.fixturesDir, 'lang-python'), dest, { recursive: true });

  const codegen = await repeatMeasure(
    async () => {
      // Remove generated file so codegen has work each time
      const gen = join(dest, 'env.py');
      if (existsSync(gen)) {
        rmSync(gen);
      }
      return measureCommand([...cli.command, 'load', '--clear-cache'], { cwd: dest, env });
    },
    { iterations: ctx.iterations, warmup: ctx.warmup },
  );
  results.push({
    id: 'lang.python.load-codegen',
    facet: 'lang-python',
    installMethod: cli.label,
    packageManager: cli.packageManager,
    telemetry: 'off',
    metrics: codegen,
    notes: 'load triggers @generatePythonEnv',
  });

  // Ensure generated file exists for run
  await measureCommand([...cli.command, 'load'], { cwd: dest, env });

  const wrapped = await repeatMeasure(
    async () => measureCommand([...cli.command, 'run', '--', 'python3', 'main.py'], { cwd: dest, env }),
    { iterations: ctx.iterations, warmup: ctx.warmup },
  );
  results.push({
    id: 'lang.python.run',
    facet: 'lang-python',
    installMethod: cli.label,
    packageManager: cli.packageManager,
    telemetry: 'off',
    metrics: wrapped,
  });

  return results;
}
