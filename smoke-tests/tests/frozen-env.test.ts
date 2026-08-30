import {
  describe, test, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { runVarlock, varlockRun } from '../helpers/run-varlock.js';

// End-to-end tests for `varlock freeze` + booting from the resulting `.varlock-frozen-env`:
//  - the artifact is consumed in a directory with NO .env files and no varlock CLI
//  - values, coerced types, and sensitivity all survive the round trip
//  - a file that is present but unusable fails closed rather than re-resolving
// See https://varlock.dev/guides/frozen-env/

const SCENARIO = 'smoke-test-frozen-env';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);
const FROZEN_FILE = join(SCENARIO_DIR, '.varlock-frozen-env');

let encryptionKey: string;
/** a deploy-like dir: the app + the frozen artifact, and nothing else */
let deployDir: string;

/** env vars that could leak in from the test runner's own environment and mask a failure */
const ISOLATED_KEYS = [
  '__VARLOCK_ENV',
  '_VARLOCK_ENV_KEY',
  '_VARLOCK_USE_INJECTED_ENV',
  '_VARLOCK_USE_FROZEN_ENV',
  'APP_ENV',
  'PUBLIC_VAR',
  'SECRET_TOKEN',
  'COERCED_FLAG',
];

function runApp(opts: { cwd?: string, env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const key of ISOLATED_KEYS) {
    if (!(opts.env && key in opts.env)) delete env[key];
  }
  const result = spawnSync(process.execPath, ['app.mjs'], {
    cwd: opts.cwd ?? deployDir,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

function freeze(opts?: { args?: Array<string>, env?: Record<string, string> }) {
  return runVarlock(['freeze', ...(opts?.args ?? [])], {
    cwd: SCENARIO,
    env: { APP_ENV: 'production', _VARLOCK_ENV_KEY: encryptionKey, ...opts?.env },
  });
}

beforeAll(() => {
  const keyResult = runVarlock(['generate-key', '--plain']);
  expect(keyResult.exitCode).toBe(0);
  encryptionKey = keyResult.stdout.trim();

  const result = freeze();
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain('environment: production');

  // node_modules is symlinked so `varlock/auto-load` resolves, but there are no .env files
  // here at all - everything the app sees has to come out of the frozen artifact
  deployDir = fs.mkdtempSync(join(os.tmpdir(), 'varlock-frozen-deploy-'));
  fs.copyFileSync(join(SCENARIO_DIR, 'app.mjs'), join(deployDir, 'app.mjs'));
  fs.copyFileSync(FROZEN_FILE, join(deployDir, '.varlock-frozen-env'));
  fs.symlinkSync(
    join(import.meta.dirname, '..', 'node_modules'),
    join(deployDir, 'node_modules'),
    'dir',
  );
});

afterAll(() => {
  fs.rmSync(FROZEN_FILE, { force: true });
  if (deployDir) fs.rmSync(deployDir, { recursive: true, force: true });
});

describe('varlock freeze', () => {
  test('refuses to write an unencrypted file without a key', () => {
    const result = runVarlock(['freeze', '--out', '.varlock-frozen-env-nokey'], {
      cwd: SCENARIO,
      env: { APP_ENV: 'production', _VARLOCK_ENV_KEY: '' },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('_VARLOCK_ENV_KEY is not set');
    expect(fs.existsSync(join(SCENARIO_DIR, '.varlock-frozen-env-nokey'))).toBe(false);
  });

  test('writes an encrypted file', () => {
    const contents = fs.readFileSync(FROZEN_FILE, 'utf8');
    expect(contents.startsWith('varlock:v1:')).toBe(true);
    // no resolved value should be greppable in the artifact
    expect(contents).not.toContain('prod-token');
  });

  // --env is only a fallback, so a @currentEnv schema ignores it - silently freezing the
  // wrong environment into a deploy artifact is the failure this command exists to prevent
  test('refuses --env when the schema sets @currentEnv', () => {
    const result = runVarlock(['freeze', '--out', '.varlock-frozen-env-badenv', '--env', 'production'], {
      cwd: SCENARIO,
      env: { _VARLOCK_ENV_KEY: encryptionKey, APP_ENV: 'development' },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('was ignored');
    expect(result.output).toContain('APP_ENV');
    expect(fs.existsSync(join(SCENARIO_DIR, '.varlock-frozen-env-badenv'))).toBe(false);
  });
});

describe('booting from a frozen env file', () => {
  test('hydrates everything with no .env files and no CLI present', () => {
    const result = runApp({ env: { _VARLOCK_ENV_KEY: encryptionKey } });
    expect(result.exitCode, result.output).toBe(0);
    // the production values, not the schema defaults
    expect(result.output).toContain('APP_ENV=production');
    expect(result.output).toContain('PUBLIC_VAR=public-value-prod');
    expect(result.output).toContain('SECRET_OK=true');
    // coerced types survive the round trip (a string "true" would fail this)
    expect(result.output).toContain('COERCED_FLAG_IS_BOOL=true');
  });

  test('varlock run consumes it too', () => {
    const result = varlockRun(['node', 'app.mjs'], {
      cwd: SCENARIO,
      env: { _VARLOCK_ENV_KEY: encryptionKey, DEBUG: 'varlock:auto-load' },
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('reusing pre-resolved env from frozen-file');
    expect(result.output).toContain('APP_ENV=production');
  });

  describe('fails closed rather than silently re-resolving', () => {
    test('when the key is missing', () => {
      const result = runApp();
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('_VARLOCK_ENV_KEY is not set');
    });

    test('when the key is wrong', () => {
      const otherKey = runVarlock(['generate-key', '--plain']).stdout.trim();
      const result = runApp({ env: { _VARLOCK_ENV_KEY: otherKey } });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('failed to decrypt');
    });

    // this is the case that matters most: the scenario dir HAS .env files, so falling back
    // would boot happily on re-resolved values and never signal that the pin was lost
    test('when the file is broken in a directory that could otherwise resolve', () => {
      const brokenFile = join(SCENARIO_DIR, '.varlock-frozen-env');
      const original = fs.readFileSync(brokenFile, 'utf8');
      fs.writeFileSync(brokenFile, 'varlock:v1:not-a-real-blob\n');
      try {
        const result = runApp({ cwd: SCENARIO_DIR, env: { _VARLOCK_ENV_KEY: encryptionKey } });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('failed to decrypt');
        expect(result.output).not.toContain('APP_ENV=development');
      } finally {
        fs.writeFileSync(brokenFile, original);
      }
    });
  });

  describe('_VARLOCK_USE_FROZEN_ENV', () => {
    afterEach(() => {
      const movedFile = `${join(deployDir, '.varlock-frozen-env')}.bak`;
      if (fs.existsSync(movedFile)) fs.renameSync(movedFile, join(deployDir, '.varlock-frozen-env'));
    });

    test('=1 makes a missing file a hard error', () => {
      fs.renameSync(join(deployDir, '.varlock-frozen-env'), `${join(deployDir, '.varlock-frozen-env')}.bak`);
      const result = runApp({ env: { _VARLOCK_ENV_KEY: encryptionKey, _VARLOCK_USE_FROZEN_ENV: '1' } });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('requires a frozen env file');
    });

    test('accepts an explicit path', () => {
      fs.renameSync(join(deployDir, '.varlock-frozen-env'), `${join(deployDir, '.varlock-frozen-env')}.bak`);
      const result = runApp({
        env: { _VARLOCK_ENV_KEY: encryptionKey, _VARLOCK_USE_FROZEN_ENV: '.varlock-frozen-env.bak' },
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('APP_ENV=production');
    });

    test('=0 ignores the file entirely', () => {
      // the deploy dir has no .env files, so ignoring the artifact leaves nothing to resolve
      const result = runApp({ env: { _VARLOCK_ENV_KEY: encryptionKey, _VARLOCK_USE_FROZEN_ENV: '0' } });
      expect(result.output).not.toContain('PUBLIC_VAR=public-value-prod');
    });
  });
});
