import {
  beforeAll, describe, expect, test,
} from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const RUN_DENO_COMPAT = process.env.VARLOCK_RUN_DENO_COMPAT === '1';

function hasDeno(): boolean {
  try {
    execSync('deno --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runDenoVarlock(args: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
}) {
  const cwd = options?.cwd ? join(SMOKE_TESTS_DIR, options.cwd) : SMOKE_TESTS_DIR;
  const env = { ...process.env, ...options?.env };
  const result = spawnSync('deno', ['run', '-A', VARLOCK_CLI, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

const denoAvailable = hasDeno();

describe.skipIf(!RUN_DENO_COMPAT)('Deno compatibility', () => {
  beforeAll(() => {
    expect(denoAvailable, 'Deno compatibility tests require the `deno` executable').toBe(true);
  });
  test('runs the CLI help through deno run -A', () => {
    const result = runDenoVarlock(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('varlock');
    expect(result.output).toContain('load');
  });

  test('loads a basic env graph as JSON', () => {
    const result = runDenoVarlock(['load', '--format', 'json'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).toBe(0);
    const vars = JSON.parse(result.stdout);
    expect(vars.NODE_ENV).toBe('test');
    expect(vars.PUBLIC_VAR).toBe('public-value');
    expect(vars.SECRET_TOKEN).toBe('super-secret-token-12345');
  });

  test('prints a single env var', () => {
    const result = runDenoVarlock(['printenv', 'PUBLIC_VAR'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('public-value');
  });

  test('runs a child command with loaded env vars', () => {
    const result = runDenoVarlock(['run', '--', 'deno', 'eval', 'console.log(Deno.env.get("PUBLIC_VAR"))'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('public-value');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('respects package.json loadPath config', () => {
    const result = runDenoVarlock(['printenv', 'PKG_JSON_VAR'], {
      cwd: 'smoke-test-pkg-json-config',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-from-pkg-json-config');
  });
});
