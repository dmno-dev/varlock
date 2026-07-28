import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import {
  mkdtempSync, rmSync, readdirSync, readFileSync, existsSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

// Cache smoke tests run with CI=true + _VARLOCK_CACHE_KEY so the disk cache
// uses env-key encryption — deterministic everywhere, and never triggers
// biometric prompts on dev machines. XDG_CONFIG_HOME isolates the cache dir.
const CACHE_KEY = randomBytes(32).toString('hex');

let configDir: string;

const cacheEnv = (extra?: Record<string, string>) => ({
  XDG_CONFIG_HOME: configDir,
  _VARLOCK_CACHE_KEY: CACHE_KEY,
  CI: 'true',
  ...extra,
});

function printCachedVal(extraArgs: Array<string> = []) {
  return runVarlock(['printenv', 'CACHED_VAL', ...extraArgs], {
    cwd: 'smoke-test-cache',
    env: cacheEnv(),
  });
}

function findCacheFiles() {
  const cacheDir = join(configDir, 'varlock', 'cache');
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'varlock-smoke-cache-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('cache() end-to-end', () => {
  test('value is stable across runs and stored encrypted on disk', () => {
    const first = printCachedVal();
    expect(first.exitCode).toBe(0);
    const value = first.stdout.trim();
    expect(value).toMatch(/^[0-9a-f]{16}$/);

    const second = printCachedVal();
    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe(value);

    // cache file exists (env-key flavor) and does not contain the plaintext value
    const files = findCacheFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^env-key-[0-9a-f]{12}\.json$/);
    const raw = readFileSync(join(configDir, 'varlock', 'cache', files[0]), 'utf-8');
    expect(raw).not.toContain(value);
    expect(raw).toContain('varlock:v1:');
  });

  test('--skip-cache resolves fresh and writes nothing', () => {
    const first = printCachedVal(['--skip-cache']);
    const second = printCachedVal(['--skip-cache']);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).not.toBe(first.stdout.trim());
    expect(findCacheFiles()).toHaveLength(0);
  });

  test('--clear-cache regenerates the value', () => {
    const first = printCachedVal();
    const cleared = printCachedVal(['--clear-cache']);
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout.trim()).not.toBe(first.stdout.trim());

    // and the regenerated value is cached again
    const third = printCachedVal();
    expect(third.stdout.trim()).toBe(cleared.stdout.trim());
  });
});

describe('varlock cache command', () => {
  test('status reports entries (non-interactive)', () => {
    printCachedVal();
    const result = runVarlock(['cache', 'status'], { env: cacheEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Total entries: 1');
  });

  test('clear refuses without --yes when non-interactive', () => {
    printCachedVal();
    const result = runVarlock(['cache', 'clear'], { env: cacheEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Refusing to clear');

    // nothing was cleared
    const status = runVarlock(['cache', 'status'], { env: cacheEnv() });
    expect(status.output).toContain('Total entries: 1');
  });

  test('clear --yes clears entries', () => {
    const first = printCachedVal();
    const result = runVarlock(['cache', 'clear', '--yes'], { env: cacheEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Cleared 1');

    const status = runVarlock(['cache', 'status'], { env: cacheEnv() });
    expect(status.output).toContain('Total entries: 0');

    // next resolution generates a fresh value
    const regenerated = printCachedVal();
    expect(regenerated.stdout.trim()).not.toBe(first.stdout.trim());
  });

  test('errors on invalid _VARLOCK_CACHE_KEY', () => {
    const result = runVarlock(['cache', 'status'], {
      env: { XDG_CONFIG_HOME: configDir, _VARLOCK_CACHE_KEY: 'bogus', CI: 'true' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('_VARLOCK_CACHE_KEY is set but invalid');
  });
});
