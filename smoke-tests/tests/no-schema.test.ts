import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

// Loading from a directory with no .env files (issue #1143). `load` and `run` error, while
// auto-load (and the framework integrations) currently only warn. `_VARLOCK_ALLOW_NO_SCHEMA=1`
// opts in to running without a schema everywhere.

const SCENARIO = 'smoke-test-no-schema';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);

function runApp(env: Record<string, string> = {}) {
  const fullEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!env._VARLOCK_ALLOW_NO_SCHEMA) delete fullEnv._VARLOCK_ALLOW_NO_SCHEMA;
  const result = spawnSync(process.execPath, ['app.mjs'], {
    cwd: SCENARIO_DIR,
    env: fullEnv as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('loading with no schema', () => {
  test('auto-load warns but still runs the app', () => {
    const { exitCode, stdout, stderr } = runApp();
    expect(exitCode).toBe(0);
    expect(stderr).toContain('No .env files found');
    expect(stderr).toContain('_VARLOCK_ALLOW_NO_SCHEMA=1');
    expect(stdout).toContain('DOWNSTREAM_RAN');
  });

  test('auto-load with _VARLOCK_ALLOW_NO_SCHEMA=1 does not warn', () => {
    const { exitCode, stdout, stderr } = runApp({ _VARLOCK_ALLOW_NO_SCHEMA: '1' });
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('No .env files found');
    expect(stdout).toContain('DOWNSTREAM_RAN');
  });

  test('varlock load and run error', () => {
    expect(runVarlock(['load'], { cwd: SCENARIO }).exitCode).not.toBe(0);
    const run = runVarlock(['run', '--', 'node', '-e', 'console.log("CHILD_RAN")'], { cwd: SCENARIO });
    expect(run.exitCode).not.toBe(0);
    expect(run.output).not.toContain('CHILD_RAN');
  });

  test('varlock load and run succeed with _VARLOCK_ALLOW_NO_SCHEMA=1', () => {
    const env = { _VARLOCK_ALLOW_NO_SCHEMA: '1' };
    const load = runVarlock(['load', '--format', 'json'], { cwd: SCENARIO, env });
    expect(load.exitCode).toBe(0);
    expect(JSON.parse(load.stdout)).toEqual({});
    const run = runVarlock(['run', '--', 'node', '-e', 'console.log("CHILD_RAN")'], { cwd: SCENARIO, env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('CHILD_RAN');
  });
});
