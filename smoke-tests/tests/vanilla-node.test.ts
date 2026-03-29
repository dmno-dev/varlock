import {
  describe, test, expect,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

/**
 * Run a Node.js script directly (without `varlock run`).
 * Used to test the dotenv drop-in replacement (`import 'varlock/config'`).
 */
function runNodeScript(scriptPath: string, cwd: string) {
  const result = spawnSync('node', [scriptPath], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

describe('Vanilla Node.js (dotenv drop-in)', () => {
  test('varlock load --format json-full stdout is valid JSON when schema has errors', () => {
    // Run `varlock load --format json-full --compact` directly.
    // With the fix, error messages go to stderr, so stdout should be either empty (on exit 1)
    // or valid JSON (on exit 0) — never a mix of error text + JSON.
    const result = runVarlock(['load', '--format', 'json-full', '--compact'], {
      cwd: 'smoke-test-vanilla-node',
      captureOutput: true,
    });

    // The schema has a missing required variable, so this should fail
    expect(result.exitCode).not.toBe(0);

    // stdout must NOT contain any non-JSON error messages —
    // errors must only appear on stderr
    if (result.stdout.trim()) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }

    // The error details should be on stderr
    expect(result.stderr).toContain('🚨');
  });

  test('importing varlock/config with a bad schema does not cause a JSON parse error', () => {
    const cwd = join(SMOKE_TESTS_DIR, 'smoke-test-vanilla-node');
    const result = runNodeScript('app.mjs', cwd);

    // Schema has a missing required variable — process should exit non-zero
    expect(result.exitCode).not.toBe(0);

    // The failure must NOT be a JSON parse error (the bug this test guards against).
    // Previously, error messages went to stdout of the `varlock load` child process,
    // and execSyncVarlock re-emitted them via console.log() to this process's stdout.
    // That caused JSON.parse() to fail with "Unrecognized token '🚨'" when the output
    // was later passed to JSON.parse(). With the fix, errors go to stderr only.
    expect(result.output).not.toMatch(/JSON [Pp]arse [Ee]rror/);
    expect(result.output).not.toMatch(/Unrecognized token/);
    expect(result.output).not.toMatch(/SyntaxError.*JSON/);

    // Error diagnostic messages must NOT appear on stdout (they should be on stderr only)
    expect(result.stdout).not.toContain('🚨');
    // And the error must actually appear on stderr
    expect(result.stderr).toContain('🚨');
  });
});
