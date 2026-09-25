import {
  describe, test, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { runVarlock, varlockRun } from '../helpers/run-varlock.js';

// End-to-end tests for `@dynamic=boot` under `varlock freeze`:
//  - boot keys are left out of the pin, and freeze does not need them set
//  - at boot they are resolved and validated against the schema, everything else stays sealed
//  - the pin is checked against the schema it was frozen from
// See https://varlock.dev/guides/deploy-time-config/#keys-supplied-at-boot

const SCENARIO = 'smoke-test-frozen-env-boot';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);
const FROZEN_FILE = join(SCENARIO_DIR, '.varlock-frozen-env');

let encryptionKey: string;

/** env vars that could leak in from the test runner's own environment and mask a failure */
const ISOLATED_KEYS = [
  '__VARLOCK_ENV',
  '_VARLOCK_ENV_KEY',
  '_VARLOCK_USE_INJECTED_ENV',
  '_VARLOCK_USE_FROZEN_ENV',
  'APP_ENV',
  'SECRET_TOKEN',
  'PORT',
  'INSTANCE_ID',
  'PUBLIC_URL',
  'DEBUG',
];

function isolatedEnv(env?: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of ISOLATED_KEYS) {
    if (!(env && key in env)) delete merged[key];
  }
  return merged;
}

/** boot the app directly (`varlock/auto-load`), with the CLI reachable through node_modules */
function runApp(env?: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, ['app.mjs'], {
    cwd: SCENARIO_DIR,
    env: isolatedEnv(env) as NodeJS.ProcessEnv,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

/** boot the app via `varlock run` */
function runAppViaVarlockRun(env?: Record<string, string | undefined>) {
  return varlockRun(['node', 'app.mjs'], {
    cwd: SCENARIO,
    env: isolatedEnv(env) as Record<string, string>,
  });
}

function freeze(opts?: { args?: Array<string>, env?: Record<string, string> }) {
  return runVarlock(['freeze', ...(opts?.args ?? [])], {
    cwd: SCENARIO,
    env: isolatedEnv({ APP_ENV: 'production', _VARLOCK_ENV_KEY: encryptionKey, ...opts?.env }) as Record<string, string>,
  });
}

beforeAll(() => {
  const keyResult = runVarlock(['generate-key', '--plain']);
  expect(keyResult.exitCode).toBe(0);
  encryptionKey = keyResult.stdout.trim();

  // a PORT set on the CI machine must not leak into the pin either
  const result = freeze({ env: { PORT: '9999' } });
  expect(result.exitCode, result.output).toBe(0);
});

afterAll(() => {
  fs.rmSync(FROZEN_FILE, { force: true });
});

describe('varlock freeze with @dynamic=boot keys', () => {
  test('succeeds without the boot keys set, and says what it left out', () => {
    const result = freeze({ args: ['--out', '.varlock-frozen-env-again'] });
    fs.rmSync(join(SCENARIO_DIR, '.varlock-frozen-env-again'), { force: true });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('environment: production');
    expect(result.output).toContain('left to boot (@dynamic=boot): PORT, INSTANCE_ID, PUBLIC_URL');
    expect(result.output).toContain('needs the varlock CLI');
  });

  test('the pin holds only the pinned keys and records the boot keys', () => {
    const outFile = '.varlock-frozen-env-plain';
    const result = freeze({ args: ['--out', outFile, '--allow-plaintext'], env: { _VARLOCK_ENV_KEY: '', PORT: '9999' } });
    try {
      expect(result.exitCode, result.output).toBe(0);
      const payload = JSON.parse(fs.readFileSync(join(SCENARIO_DIR, outFile), 'utf8'));
      expect(Object.keys(payload.config).sort()).toEqual(['APP_ENV', 'SECRET_TOKEN']);
      expect(payload.frozen).toEqual({ bootKeys: ['PORT', 'INSTANCE_ID', 'PUBLIC_URL'], currentEnv: 'production' });
    } finally {
      fs.rmSync(join(SCENARIO_DIR, outFile), { force: true });
    }
  });

  test('a pinned key that depends on a boot key is a schema error on any load', () => {
    const badDir = join(SCENARIO_DIR, 'bad-dep');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(join(badDir, '.env.schema'), [
      '# @defaultSensitive=false',
      '# ---',
      '# @type=port @dynamic=boot',
      'PORT=3000',
      'PUBLIC_URL=http://localhost:${PORT}', // eslint-disable-line no-template-curly-in-string
      '',
    ].join('\n'));
    try {
      const result = runVarlock(['load'], { cwd: `${SCENARIO}/bad-dep`, env: isolatedEnv() as Record<string, string> });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('PUBLIC_URL depends on PORT, which is @dynamic=boot');
      expect(result.output).toContain('Mark PUBLIC_URL @dynamic=boot too');
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});

describe('booting with boot keys', () => {
  const bootEnv = { _VARLOCK_ENV_KEY: encryptionKey!, PORT: '8080' };

  test('varlock run resolves the boot keys against the schema and keeps the rest sealed', () => {
    const result = runAppViaVarlockRun({
      ...bootEnv,
      _VARLOCK_ENV_KEY: encryptionKey,
      // an ambient value for a pinned key is ignored - the seal is still total for those
      SECRET_TOKEN: 'ambient-token',
      INSTANCE_ID: 'i-123',
      DEBUG: 'varlock:run',
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('frozen env file leaves 3 keys to boot');
    expect(result.output).toContain('APP_ENV=production');
    expect(result.output).toContain('SECRET_OK=true');
    expect(result.output).toContain('PORT=8080');
    expect(result.output).toContain('PORT_IS_NUMBER=true');
    expect(result.output).toContain('INSTANCE_ID="i-123"');
    // derived from the boot value at boot, not frozen with an empty PORT
    expect(result.output).toContain('PUBLIC_URL=http://localhost:8080');
  });

  test('varlock/auto-load hands the pin to the CLI and gets the same result', () => {
    const result = runApp({ ...bootEnv, _VARLOCK_ENV_KEY: encryptionKey, DEBUG: 'varlock:auto-load' });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('resolving env via CLI (frozen env file leaves 3 keys to boot');
    expect(result.output).toContain('APP_ENV=production');
    expect(result.output).toContain('SECRET_OK=true');
    expect(result.output).toContain('PORT_IS_NUMBER=true');
    expect(result.output).toContain('INSTANCE_ID=undefined');
    expect(result.output).toContain('PUBLIC_URL=http://localhost:8080');
  });

  test('a required boot key that is missing fails the boot', () => {
    const result = runAppViaVarlockRun({ _VARLOCK_ENV_KEY: encryptionKey });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('PORT');
    expect(result.output).toContain('required');
    expect(result.output).not.toContain('APP_ENV=production');
  });

  test('a boot key is validated like any other value', () => {
    const result = runAppViaVarlockRun({ _VARLOCK_ENV_KEY: encryptionKey, PORT: 'not-a-port' });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('PORT');
    expect(result.output).not.toContain('APP_ENV=production');
  });

  test('_VARLOCK_USE_FROZEN_ENV=1 varlock load shows the pinned-plus-boot view', () => {
    const result = runVarlock(['load', '--format', 'json'], {
      cwd: SCENARIO,
      env: isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, _VARLOCK_USE_FROZEN_ENV: '1', PORT: '8080' }) as Record<string, string>,
    });
    expect(result.exitCode, result.output).toBe(0);
    const values = JSON.parse(result.stdout);
    expect(values.APP_ENV).toBe('production');
    expect(values.PORT).toBe(8080);
    expect(values.PUBLIC_URL).toBe('http://localhost:8080');
  });

  test('a plain varlock load ignores a merely-present pin', () => {
    const result = runVarlock(['load', '--format', 'json'], {
      cwd: SCENARIO,
      env: isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, PORT: '8080' }) as Record<string, string>,
    });
    expect(result.exitCode, result.output).toBe(0);
    // resolved from the .env files: no APP_ENV set, so development
    expect(JSON.parse(result.stdout).APP_ENV).toBe('development');
  });
});

describe('the pin must match the schema', () => {
  const driftDir = join(SCENARIO_DIR, 'drifted');

  afterEach(() => {
    fs.rmSync(driftDir, { recursive: true, force: true });
  });

  function setupDriftedSchema(mutate: (schema: string) => string) {
    fs.mkdirSync(driftDir, { recursive: true });
    fs.writeFileSync(join(driftDir, '.env.schema'), mutate(fs.readFileSync(join(SCENARIO_DIR, '.env.schema'), 'utf8')));
    fs.copyFileSync(join(SCENARIO_DIR, '.env.production'), join(driftDir, '.env.production'));
    fs.copyFileSync(FROZEN_FILE, join(driftDir, '.varlock-frozen-env'));
    fs.copyFileSync(join(SCENARIO_DIR, 'app.mjs'), join(driftDir, 'app.mjs'));
  }

  function bootDrifted() {
    return varlockRun(['node', 'app.mjs'], {
      cwd: `${SCENARIO}/drifted`,
      env: isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, PORT: '8080' }) as Record<string, string>,
    });
  }

  test('a key added since the freeze is not silently resolved at boot', () => {
    setupDriftedSchema((schema) => `${schema}\nADDED_LATER=x\n`);
    const result = bootDrifted();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('does not match the schema');
    expect(result.output).toContain('not in the pin: ADDED_LATER');
    expect(result.output).not.toContain('APP_ENV=production');
  });

  test('a boot marking that changed since the freeze is caught too', () => {
    setupDriftedSchema((schema) => schema.replace('# @optional @dynamic=boot\nINSTANCE_ID=', '# @optional\nINSTANCE_ID='));
    const result = bootDrifted();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('left to boot by the pin but not @dynamic=boot in the schema: INSTANCE_ID');
  });
});
