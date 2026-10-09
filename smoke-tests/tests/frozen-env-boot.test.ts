import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { runVarlock as runVarlockRaw, VARLOCK_CLI } from '../helpers/run-varlock.js';

// End-to-end tests for `@dynamic=boot` under `varlock freeze`:
//  - boot items are frozen like everything else, their freeze-time value is the default
//  - at boot the environment may override them, checked against the type the freeze recorded
//  - so booting never needs the schema or the CLI, even with boot items
// See https://varlock.dev/guides/deploy-time-config/#keys-supplied-at-boot

// CI runners force colored output, which splits phrases like `environment: production` with
// escape codes - assert on the plain text
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function plain<T extends { stdout: string, stderr: string, output: string }>(r: T): T {
  return {
    ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr), output: stripAnsi(r.output),
  };
}
const runVarlock = (...args: Parameters<typeof runVarlockRaw>) => plain(runVarlockRaw(...args));

const SCENARIO = 'smoke-test-frozen-env-boot';
const SCENARIO_DIR = join(import.meta.dirname, '..', SCENARIO);
const FROZEN_FILE = join(SCENARIO_DIR, '.varlock-frozen-env');

let encryptionKey: string;
/** a deploy-like dir: the app + the frozen artifact, no .env.schema or any other .env file */
let deployDir: string;

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
  'LOG_TAG',
  'DEBUG',
];

function isolatedEnv(env?: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of ISOLATED_KEYS) {
    if (!(env && key in env)) delete merged[key];
  }
  return merged as Record<string, string>;
}

function spawnIn(cwd: string, args: Array<string>, env?: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, _VARLOCK_USE_FROZEN_ENV: '1', ...env }),
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    output: stripAnsi((result.stdout ?? '') + (result.stderr ?? '')),
  };
}

/** boot the app directly (`varlock/auto-load`) from the deploy dir */
const bootApp = (env?: Record<string, string | undefined>) => spawnIn(deployDir, ['app.mjs'], env);
/** run the varlock CLI in the deploy dir */
const varlockInDeploy = (args: Array<string>, env?: Record<string, string | undefined>) => (
  spawnIn(deployDir, [VARLOCK_CLI, ...args], env)
);

function freeze(opts?: { args?: Array<string>, env?: Record<string, string> }) {
  return runVarlock(['freeze', ...(opts?.args ?? [])], {
    cwd: SCENARIO,
    env: isolatedEnv({ APP_ENV: 'production', _VARLOCK_ENV_KEY: encryptionKey, ...opts?.env }),
  });
}

beforeAll(() => {
  const keyResult = runVarlock(['generate-key', '--plain']);
  expect(keyResult.exitCode).toBe(0);
  encryptionKey = keyResult.stdout.trim();

  const result = freeze();
  expect(result.exitCode, result.output).toBe(0);

  deployDir = fs.mkdtempSync(join(os.tmpdir(), 'varlock-frozen-boot-deploy-'));
  fs.copyFileSync(join(SCENARIO_DIR, 'app.mjs'), join(deployDir, 'app.mjs'));
  fs.copyFileSync(FROZEN_FILE, join(deployDir, '.varlock-frozen-env'));
  fs.symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(deployDir, 'node_modules'), 'dir');
});

afterAll(() => {
  fs.rmSync(FROZEN_FILE, { force: true });
  if (deployDir) fs.rmSync(deployDir, { recursive: true, force: true });
});

describe('varlock freeze with @dynamic=boot items', () => {
  test('a required boot item need not be set at freeze time, and the summary names each default', () => {
    const result = freeze({ args: ['--out', '.varlock-frozen-env-again'] });
    fs.rmSync(join(SCENARIO_DIR, '.varlock-frozen-env-again'), { force: true });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('can be set at boot (@dynamic=boot)');
    // the environment-specific value is the default
    expect(result.output).toContain('PORT (default 8000)');
    expect(result.output).toContain('INSTANCE_ID (no default, must be set at boot)');
    expect(result.output).toContain('LOG_TAG (default "app-production")');
  });

  // whatever resolves at freeze time is the default, including a value from the build env -
  // the summary says so, since that is easy to miss
  test('a value from the build environment becomes the default, and is called out', () => {
    const outFile = '.varlock-frozen-env-plain';
    const result = freeze({ args: ['--out', outFile, '--allow-plaintext'], env: { _VARLOCK_ENV_KEY: '', PORT: '9999' } });
    try {
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('PORT (default 9999, from the build environment)');
      const payload = JSON.parse(fs.readFileSync(join(SCENARIO_DIR, outFile), 'utf8'));
      expect(payload.config.PORT.value).toBe(9999);
      expect(payload.frozen).toBe(true);
      // each boot item carries its own spec, the value being its default
      expect(payload.config.PORT.boot).toEqual({ type: 'port', required: true });
      expect(payload.config.INSTANCE_ID.boot).toEqual({ type: 'string', required: true });
      expect(payload.config.LOG_TAG.boot).toEqual({ type: 'string', required: true });
      expect(payload.config.APP_ENV.boot).toBeUndefined();
    } finally {
      fs.rmSync(join(SCENARIO_DIR, outFile), { force: true });
    }
  });

  test('anything referencing a boot item is a schema error on any load, with the fix', () => {
    const badDir = join(SCENARIO_DIR, 'bad-dep');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(join(badDir, '.env.schema'), [
      '# @defaultSensitive=false',
      '# ---',
      '# @type=port @dynamic=boot',
      'PORT=3000',
      '# @dynamic=boot',
      'PUBLIC_URL=http://localhost:${PORT}', // eslint-disable-line no-template-curly-in-string
      '',
    ].join('\n'));
    try {
      const result = runVarlock(['load'], { cwd: `${SCENARIO}/bad-dep`, env: isolatedEnv() });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('PUBLIC_URL depends on PORT, which is @dynamic=boot');
      expect(result.output).toContain('Derive PUBLIC_URL from PORT in your app code at boot');
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});

// the deploy dir has no .env.schema, so every passing boot below also shows the schema (and
// the CLI's resolution) was never needed
describe('booting with boot items, no schema present', () => {
  test('varlock/auto-load applies boot values in-process, checked against the recorded types', () => {
    const result = bootApp({ PORT: '8080', INSTANCE_ID: 'i-123', SECRET_TOKEN: 'ambient-token' });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('APP_ENV=production');
    // everything else stays frozen, even with an ambient value set
    expect(result.output).toContain('SECRET_OK=true');
    expect(result.output).toContain('PORT=8080');
    expect(result.output).toContain('PORT_IS_NUMBER=true');
    expect(result.output).toContain('PORT_env=8080');
    expect(result.output).toContain('INSTANCE_ID="i-123"');
    expect(result.output).toContain('LOG_TAG=app-production');
  });

  test('a boot item not set at boot keeps its frozen default', () => {
    const result = bootApp({ INSTANCE_ID: 'i-123' });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('PORT=8000');
  });

  test('varlock run applies them the same way', () => {
    const result = varlockInDeploy(['run', '--', process.execPath, 'app.mjs'], { PORT: '8081', INSTANCE_ID: 'i-9' });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('PORT=8081');
    expect(result.output).toContain('INSTANCE_ID="i-9"');
  });

  test('a required boot item with no default must be set at boot', () => {
    const result = bootApp({ PORT: '8080' });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('INSTANCE_ID is required, but it is not set at boot');
    expect(result.output).not.toContain('APP_ENV=production');
  });

  test('a boot value is validated like any other value', () => {
    const result = bootApp({ PORT: 'not-a-port', INSTANCE_ID: 'i-1' });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('invalid @dynamic=boot value');
    expect(result.output).toContain('PORT');
    expect(result.output).not.toContain('APP_ENV=production');
  });

  test('varlock load --frozen shows the frozen values with boot values applied', () => {
    const result = varlockInDeploy(['load', '--frozen', '--format', 'json'], { PORT: '8080', INSTANCE_ID: 'i-1' });
    expect(result.exitCode, result.output).toBe(0);
    const values = JSON.parse(result.stdout);
    expect(values).toMatchObject({
      APP_ENV: 'production', PORT: 8080, INSTANCE_ID: 'i-1', LOG_TAG: 'app-production',
    });
  });
});

describe('varlock load next to a frozen file', () => {
  // a frozen file is only used when asked for, so a plain load is unaffected by one
  test('a plain varlock load resolves from .env files', () => {
    const result = runVarlock(['load', '--format', 'json'], { cwd: SCENARIO, env: isolatedEnv({ INSTANCE_ID: 'i-1' }) });
    expect(result.exitCode, result.output).toBe(0);
    // resolved from the .env files: no APP_ENV set, so development
    expect(JSON.parse(result.stdout).APP_ENV).toBe('development');
    expect(result.stderr).not.toContain('frozen');
  });

  test('--frozen is the flag form of _VARLOCK_USE_FROZEN_ENV', () => {
    const env = isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, INSTANCE_ID: 'i-1' });
    const bare = runVarlock(['load', '--frozen', '--format', 'json'], { cwd: SCENARIO, env });
    expect(bare.exitCode, bare.output).toBe(0);
    expect(JSON.parse(bare.stdout).APP_ENV).toBe('production');

    const withPath = runVarlock(['load', '--format', 'json', '--frozen', '.varlock-frozen-env'], { cwd: SCENARIO, env });
    expect(withPath.exitCode, withPath.output).toBe(0);
    expect(JSON.parse(withPath.stdout).APP_ENV).toBe('production');

    const missing = runVarlock(['load', '--frozen=nope.env'], { cwd: SCENARIO, env });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.output).toContain('requires a frozen env file');
  });

  test('varlock load --frozen rejects flags that only make sense for a fresh resolution', () => {
    const result = runVarlock(['load', '--frozen', '--skip-cache'], {
      cwd: SCENARIO,
      env: isolatedEnv({ _VARLOCK_ENV_KEY: encryptionKey, INSTANCE_ID: 'i-1' }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('cannot be combined with --skip-cache');
  });
});
