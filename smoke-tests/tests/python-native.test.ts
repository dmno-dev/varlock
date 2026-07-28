import { describe, expect, test } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { varlockRun } from '../helpers/run-varlock';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const TEST_DIR = join(SMOKE_TESTS_DIR, 'smoke-test-python-native');
// run the package straight from source - it has no build step and no dependencies
const PY_SRC_DIR = join(SMOKE_TESTS_DIR, '..', 'packages', 'varlock-python', 'src');
// pin the CLI the package discovers to the installed one (the packed .tgz in CI), so the test
// can't silently run against a different varlock that happens to be on the dev machine's PATH
const VARLOCK_BIN = join(SMOKE_TESTS_DIR, 'node_modules', '.bin', 'varlock');

function hasTool(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runPython(env?: Record<string, string>) {
  const result = spawnSync('python3', ['main.py'], {
    cwd: TEST_DIR,
    env: {
      ...process.env, PYTHONPATH: PY_SRC_DIR, VARLOCK_BIN, ...env,
    },
    encoding: 'utf-8',
  });
  return {
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    exitCode: result.status ?? 1,
  };
}

// The native package resolves values by calling the CLI, so these cover both directions:
// resolving in-process (no wrapped launch, the notebook case) and adopting the blob that
// `varlock run` already injected. main.py asserts the same things in both.
describe.skipIf(!hasTool('python3'))('native python package', () => {
  test('resolves in-process without a wrapped launch', () => {
    const result = runPython();
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test('adopts the blob injected by varlock run', () => {
    const result = varlockRun(['python3', 'main.py'], {
      cwd: 'smoke-test-python-native',
      env: { PYTHONPATH: PY_SRC_DIR, EXPECT_VARLOCK_RUN: '1' },
    });
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test('reports a schema failure with the CLI output', () => {
    const result = spawnSync('python3', [
      '-c', [
        'import varlock',
        'try:',
        '    varlock.load(path="does-not-exist.env")',
        'except varlock.VarlockLoadError as err:',
        '    print("CAUGHT", err.exit_code)',
      ].join('\n'),
    ], {
      cwd: TEST_DIR,
      env: { ...process.env, PYTHONPATH: PY_SRC_DIR, VARLOCK_BIN },
      encoding: 'utf-8',
    });
    expect(result.stdout).toContain('CAUGHT');
    expect(result.status).toBe(0);
  }, 60_000);
});
