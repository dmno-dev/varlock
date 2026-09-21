import {
  describe, test, expect,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// nub (https://nubjs.com) hands the environment to varlock whenever it finds a `.env.schema`:
// it puts `varlock run -- node ...` in front of every file and script it runs, with no wrapper
// command and no import in the app. Its `node` is a PATH shim that re-enters nub, and it injects
// its own NODE_OPTIONS preload for TypeScript, so this suite checks that varlock's spawn chain
// (`varlock run`, auto-load's blob reuse, and auto-load's CLI child) holds up inside that setup.
const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const NUB_DIR = join(SMOKE_TESTS_DIR, 'smoke-test-nub');
const NUB_BIN = join(SMOKE_TESTS_DIR, 'node_modules', '.bin', 'nub');
const SECRET = 'super-secret-token-12345';

function runNub(args: Array<string>, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(NUB_BIN, args, {
    cwd: NUB_DIR,
    env: {
      ...process.env,
      // the installed CLI must win the `varlock` lookup over any globally installed varlock
      PATH: `${join(SMOKE_TESTS_DIR, 'node_modules', '.bin')}:${process.env.PATH}`,
      // pin nub to the node running the tests so it never tries to install one
      NODE_EXECUTABLE: process.execPath,
      ...extraEnv,
    },
    encoding: 'utf-8',
    // a spawn loop would never exit on its own
    timeout: 60000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // strip ANSI so debug lines can be matched
    // eslint-disable-next-line no-control-regex
    output: ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, ''),
  };
}

// nub is not published for every platform the smoke suite runs on, and the PATH-shim behavior
// has only been verified on posix
describe.skipIf(process.platform === 'win32' || !existsSync(NUB_BIN))('nub hand-over to varlock', () => {
  test('a plain file gets env from varlock run, with redacted output', () => {
    const result = runNub(['script.js']);

    expect(result.output).toContain('PUBLIC_VAR: public-value');
    expect(result.output).toContain('under varlock run: 1');
    expect(result.output).toContain('nub ok');
    expect(result.output).not.toContain(SECRET);
    expect(result.exitCode).toBe(0);
  });

  test('a package.json script goes through the same hand-over', () => {
    const result = runNub(['run', 'print']);

    expect(result.output).toContain('PUBLIC_VAR: public-value');
    expect(result.output).toContain('under varlock run: 1');
    expect(result.output).not.toContain(SECRET);
    expect(result.exitCode).toBe(0);
  });

  test('a TypeScript entry still transpiles: nub preload survives the varlock run hand-over', () => {
    const result = runNub(['script.ts']);

    expect(result.output).toContain('ts PUBLIC_VAR: public-value');
    expect(result.exitCode).toBe(0);
  });

  test('an explicit varlock/auto-load import reuses the injected blob instead of resolving again', () => {
    const result = runNub(['app-autoload.mjs'], { DEBUG: 'varlock:auto-load' });

    expect(result.output).toContain('reusing injected env blob');
    expect(result.output).not.toContain('resolving env via CLI');
    expect(result.output).toContain('PUBLIC_VAR: public-value');
    // the CLI-child marker must never reach the app
    expect(result.output).toContain('marker: undefined');
    expect(result.output).not.toContain(SECRET);
    expect(result.exitCode).toBe(0);
  });

  test('a forced re-resolution spawns the varlock CLI through nub\'s node shim without re-wrapping', () => {
    // the CLI child's `#!/usr/bin/env node` resolves to nub's PATH shim, which re-enters nub in a
    // directory that has a .env.schema. it must not put another `varlock run` in front of it.
    const result = runNub(['app-autoload.mjs'], { DEBUG: 'varlock:auto-load', _VARLOCK_USE_INJECTED_ENV: '0' });

    expect(result.output).toContain('resolving env via CLI');
    expect(result.output).toContain('PUBLIC_VAR: public-value');
    expect(result.output).toContain('marker: undefined');
    expect(result.output).not.toContain(SECRET);
    expect(result.exitCode).toBe(0);
  });

  test('an ambient override on the nub command wins', () => {
    const result = runNub(['app-autoload.mjs'], { PUBLIC_VAR: 'cmdlocal' });

    expect(result.output).toContain('PUBLIC_VAR: cmdlocal');
    expect(result.exitCode).toBe(0);
  });

  test('a child process with a command-local override re-resolves and gets its value', () => {
    const result = runNub(['parent.mjs']);

    expect(result.output).toContain('resolving env via CLI (env value for PUBLIC_VAR changed');
    expect(result.output).toContain('PUBLIC_VAR: cmdlocal');
    expect(result.output).toContain('child exit: 0');
    expect(result.output).not.toContain(SECRET);
    expect(result.exitCode).toBe(0);
  });
});
