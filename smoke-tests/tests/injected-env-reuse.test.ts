import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { varlockRun, runVarlock } from '../helpers/run-varlock.js';

// End-to-end tests for `varlock/auto-load` reusing an already-injected __VARLOCK_ENV blob
// instead of spawning the CLI to re-resolve:
//  - automatic reuse when running under `varlock run` in the same directory
//  - fallback to CLI resolution on override drift (and the drifted value being honored)
//  - explicit trust via _VARLOCK_USE_INJECTED_ENV=1 in a dir with no .env files (sandbox)
// The DEBUG=varlock:auto-load output tells us which path was taken.

const SCENARIO = 'smoke-test-injected-env';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);

const REUSED_MSG = 'reusing injected env blob';
const RESOLVED_MSG = 'resolving env via CLI';

function runNodeApp(opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEBUG: 'varlock:auto-load',
    ...opts.env,
  };
  // an inherited value (e.g. if the test runner itself runs under varlock) must not
  // accidentally satisfy or flip the scenario under test
  for (const key of ['__VARLOCK_ENV', '_VARLOCK_ENV_KEY', '_VARLOCK_USE_INJECTED_ENV', 'OVERRIDE_ME', 'COERCED_FLAG']) {
    if (!(opts.env && key in opts.env)) delete env[key];
  }
  const result = spawnSync(process.execPath, ['app.mjs'], {
    cwd: opts.cwd ?? SCENARIO_DIR,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

describe('auto-load reuse of injected env blob', () => {
  test('under varlock run, the blob is reused and no re-resolution happens', () => {
    const result = varlockRun(['node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(REUSED_MSG);
    expect(result.output).not.toContain(RESOLVED_MSG);
    expect(result.output).toContain('PUBLIC_VAR=public-value');
    expect(result.output).toContain('SECRET_OK=true');
    expect(result.output).toContain('OVERRIDE_ME=default-value');
  });

  test('under varlock run --inject blob (no individual vars), the blob is still reused and hydrates process.env', () => {
    const result = runVarlock(['run', '--inject', 'blob', '--', 'node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(REUSED_MSG);
    expect(result.output).toContain('SECRET_OK=true');
  });

  test('a COERCED ambient override does not block reuse under --inject blob', () => {
    // COERCED_FLAG=YES coerces to boolean true (injected form "true"); in blob-only mode
    // no individual vars are injected, so the raw "YES" survives in the child env. The
    // blob's recorded raw override string must be recognized as an echo, not drift.
    const result = runVarlock(['run', '--inject', 'blob', '--', 'node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load', COERCED_FLAG: 'YES' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(REUSED_MSG);
    expect(result.output).toContain('COERCED_FLAG=true');
  });

  test('an ambient override at the parent invocation still reuses (value already in the blob)', () => {
    const result = varlockRun(['node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load', OVERRIDE_ME: 'parent-override' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(REUSED_MSG);
    expect(result.output).toContain('OVERRIDE_ME=parent-override');
  });

  test.skipIf(process.platform === 'win32')('override drift between run and app falls back to re-resolution and honors the new value', () => {
    const result = varlockRun(['sh', '-c', 'OVERRIDE_ME=changed-later node app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load', OVERRIDE_ME: 'parent-override' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(RESOLVED_MSG);
    expect(result.output).not.toContain(REUSED_MSG);
    expect(result.output).toContain('OVERRIDE_ME=changed-later');
  });

  test.skipIf(process.platform === 'win32')('an override INTRODUCED between run and app (not overridden at the parent) is honored', () => {
    // OVERRIDE_ME resolves from the .env file at the parent (no ambient override), so the
    // blob does not record it as an override; setting it mid-chain must still win
    const result = varlockRun(['sh', '-c', 'OVERRIDE_ME=introduced-later node app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(RESOLVED_MSG);
    expect(result.output).not.toContain(REUSED_MSG);
    expect(result.output).toContain('OVERRIDE_ME=introduced-later');
  });

  test('without a wrapping varlock run, auto-load resolves via the CLI as before', () => {
    const result = runNodeApp();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(RESOLVED_MSG);
    expect(result.output).toContain('PUBLIC_VAR=public-value');
    expect(result.output).toContain('SECRET_OK=true');
  });

  test('_VARLOCK_USE_INJECTED_ENV=0 forces re-resolution even under varlock run', () => {
    const result = varlockRun(['node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { DEBUG: 'varlock:auto-load', _VARLOCK_USE_INJECTED_ENV: '0' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(RESOLVED_MSG);
    expect(result.output).not.toContain(REUSED_MSG);
  });

  describe('sandbox mode (blob only, no env files)', () => {
    // capture a blob the way a host machine would before handing it into a sandbox
    function captureBlob() {
      const result = runVarlock(['load', '--format', 'json-full', '--compact'], { cwd: SCENARIO });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    }

    test('_VARLOCK_USE_INJECTED_ENV=1 hydrates everything from the blob with no env files present', () => {
      const blob = captureBlob();
      const result = runNodeApp({
        cwd: join(SCENARIO_DIR, 'sandbox'),
        env: {
          __VARLOCK_ENV: blob,
          _VARLOCK_USE_INJECTED_ENV: '1',
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(REUSED_MSG);
      expect(result.output).toContain('PUBLIC_VAR=public-value');
      expect(result.output).toContain('SECRET_OK=true');
      expect(result.output).toContain('OVERRIDE_ME=default-value');
    });

    test('a --filter scoped blob exposes only the selected items (the documented sandbox recipe)', () => {
      const captured = runVarlock(
        ['load', '--format', 'json-full', '--compact', '--filter', 'PUBLIC_VAR,OVERRIDE_ME'],
        { cwd: SCENARIO },
      );
      expect(captured.exitCode).toBe(0);
      const result = runNodeApp({
        cwd: join(SCENARIO_DIR, 'sandbox'),
        env: {
          __VARLOCK_ENV: captured.stdout.trim(),
          _VARLOCK_USE_INJECTED_ENV: '1',
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(REUSED_MSG);
      expect(result.output).toContain('PUBLIC_VAR=public-value');
      expect(result.output).toContain('OVERRIDE_ME=default-value');
      // SECRET_TOKEN was filtered out of the blob, so it must not be hydrated
      expect(result.output).toContain('SECRET_OK=false');
    });

    test('without the explicit flag, a foreign-directory blob is not silently reused', () => {
      const blob = captureBlob();
      const result = runNodeApp({
        cwd: join(SCENARIO_DIR, 'sandbox'),
        env: { __VARLOCK_ENV: blob },
      });
      // auto-load falls back to CLI resolution; with no env files here that yields an
      // empty env - the point is the foreign blob's values were NOT hydrated
      expect(result.output).toContain(RESOLVED_MSG);
      expect(result.output).not.toContain(REUSED_MSG);
      expect(result.output).toContain('PUBLIC_VAR=undefined');
      expect(result.output).toContain('SECRET_OK=false');
    });

    test('_VARLOCK_USE_INJECTED_ENV=1 with no blob at all is a hard error', () => {
      const result = runNodeApp({
        cwd: join(SCENARIO_DIR, 'sandbox'),
        env: { _VARLOCK_USE_INJECTED_ENV: '1' },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('no __VARLOCK_ENV blob');
    });
  });
});
