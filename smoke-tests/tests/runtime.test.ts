import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import { varlockRun, VARLOCK_CLI } from '../helpers/run-varlock.js';
import {
  writeFileSync, chmodSync, unlinkSync, mkdtempSync, rmSync, readFileSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Runtime Support', () => {
  test('should work with Node.js', () => {
    const result = varlockRun(['node', '--version'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('v');
  });

  test.skipIf(!hasBun())('should work with Bun', () => {
    const result = varlockRun(['bun', 'test-script.js'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.output).toContain('NODE_ENV: test');
    expect(result.output).toContain('All env vars loaded correctly');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('should handle command not found errors', () => {
    const result = varlockRun(['nonexistent-command-xyz'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toMatch(/command|not found|enoent/);
  });

  test.skipIf(process.platform === 'win32')('should execute shebang scripts', () => {
    // Create a temp shebang script for testing
    const testScript = join(SMOKE_TESTS_DIR, 'smoke-test-basic', 'shebang-test.js');

    writeFileSync(testScript, '#!/usr/bin/env node\nconsole.log("Shebang works");');
    chmodSync(testScript, 0o755);

    try {
      const result = varlockRun(['./shebang-test.js'], {
        cwd: 'smoke-test-basic',
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Shebang works');
    } finally {
      unlinkSync(testScript);
    }
  });

  // Regression: bunfig `preload = ["varlock/auto-load"]` in a bun-only environment where `node`
  // is a bun shim. auto-load spawns the `varlock` CLI (node shebang -> bun), bun applies the cwd
  // bunfig preload to that CLI process too, which spawned another CLI... forever.
  describe.skipIf(!hasBun() || process.platform === 'win32')('bunfig preload of auto-load with node as a bun shim', () => {
    const PRELOAD_DIR = join(SMOKE_TESTS_DIR, 'smoke-test-bun-preload');
    let shimDir: string;
    let countFile: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
      shimDir = mkdtempSync(join(tmpdir(), 'varlock-bun-shim-'));
      countFile = join(shimDir, 'node-invocations');
      // `node` shim that counts invocations and bails out past a small bound, so a regression
      // fails the test instead of fork-bombing the machine
      const bunPath = execSync('which bun', { encoding: 'utf-8' }).trim();
      writeFileSync(join(shimDir, 'node'), [
        '#!/bin/sh',
        `n=$(cat "${countFile}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${countFile}"`,
        'if [ "$n" -gt 6 ]; then echo "node shim: too many nested invocations" >&2; exit 1; fi',
        `exec "${bunPath}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(join(shimDir, 'node'), 0o755);
      // the installed CLI must win the `varlock` PATH lookup over any globally installed varlock
      const localBin = join(SMOKE_TESTS_DIR, 'node_modules', '.bin');
      env = { ...process.env, PATH: `${shimDir}:${localBin}:${process.env.PATH}` };
    });

    afterEach(() => {
      rmSync(shimDir, { recursive: true, force: true });
    });

    const nodeInvocations = () => Number(readFileSync(countFile, 'utf-8').trim());

    test('does not recurse and loads env', () => {
      const result = spawnSync('node', ['script.js'], {
        cwd: PRELOAD_DIR, env, encoding: 'utf-8', timeout: 30000,
      });
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(output).toContain('preload ok');
      expect(output).toContain('PUBLIC_VAR: public-value');
      expect(result.status).toBe(0);
      // app process + exactly one CLI child
      expect(nodeInvocations()).toBe(2);
    });

    test('nested under varlock run: command-local override wins and the marker does not leak', () => {
      // the varlock run CLI process is itself preloaded; its own auto-load resolves via a marked
      // CLI child, which is preloaded too. a command-local override on the app must survive all
      // of that (the runtime auto-init from the inherited blob must not clobber it) and the app
      // must not inherit the CLI-child marker
      const result = spawnSync('node', [
        VARLOCK_CLI,
        'run',
        '--',
        'sh',
        '-c',
        'PUBLIC_VAR=cmdlocal node -e "console.log(\'PUBLIC_VAR=\' + process.env.PUBLIC_VAR, \'marker=\' + process.env.__VARLOCK_CLI_CHILD)"',
      ], {
        cwd: PRELOAD_DIR, env, encoding: 'utf-8', timeout: 30000,
      });
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(output).toContain('PUBLIC_VAR=cmdlocal marker=undefined');
      expect(result.status).toBe(0);
      // varlock run + its load child + the app + the app's load child (override rejects blob reuse)
      expect(nodeInvocations()).toBe(4);
    });
  });
});
