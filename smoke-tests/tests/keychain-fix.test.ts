import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-fix';
const PROFILE = 'local';
const PROJECT = 'smoke-test-keychain-fix';
const FIXTURE_DIR = PROJECT;
const FIXTURE_SCHEMA = '.env.schema';
const FIXED_SECRETS = {
  FIXED_API_KEY: 'fixed-api-key-from-keychain',
  FIXED_DATABASE_URL: 'postgres://fixed-user:fixed-pass@localhost:5432/fixed-db',
};
const FIXED_ACCOUNTS = Object.keys(FIXED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:${key}`);

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function deleteFixedSecrets() {
  for (const account of FIXED_ACCOUNTS) {
    security(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
}

function createKeychainItem(account: string, value: string) {
  const result = security([
    'add-generic-password',
    '-U',
    '-s',
    SERVICE,
    '-a',
    account,
    '-w',
    value,
    '-T',
    '',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

beforeEach(() => {
  resetVarlockDaemon();
  deleteFixedSecrets();
  for (const [key, value] of Object.entries(FIXED_SECRETS)) {
    createKeychainItem(`${PROJECT}:${PROFILE}:${key}`, value);
  }
});

afterEach(() => {
  deleteFixedSecrets();
  resetVarlockDaemon();
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain fix-access smoke tests', () => {
  test('fixes access for keychain refs in the fixture schema and reads the secrets', () => {
    const fixAccessResult = runVarlock([
      'keychain',
      'fix-access',
      '--path',
      FIXTURE_SCHEMA,
    ], { cwd: FIXTURE_DIR });
    expect(fixAccessResult.exitCode, fixAccessResult.output).toBe(0);

    const apiKeyResult = runVarlock(['printenv', 'FIXED_API_KEY', '--skip-cache'], { cwd: FIXTURE_DIR });
    expect(apiKeyResult.exitCode, apiKeyResult.output).toBe(0);
    expect(apiKeyResult.stdout.trim()).toBe(FIXED_SECRETS.FIXED_API_KEY);

    const databaseUrlResult = runVarlock(['printenv', 'FIXED_DATABASE_URL', '--skip-cache'], { cwd: FIXTURE_DIR });
    expect(databaseUrlResult.exitCode, databaseUrlResult.output).toBe(0);
    expect(databaseUrlResult.stdout.trim()).toBe(FIXED_SECRETS.FIXED_DATABASE_URL);

    const loadAfterFixResult = runVarlock(['load', '--format', 'json', '--skip-cache'], {
      cwd: FIXTURE_DIR,
    });
    expect(loadAfterFixResult.exitCode, loadAfterFixResult.output).toBe(0);
    const vars = JSON.parse(loadAfterFixResult.stdout);
    expect(vars.FIXED_API_KEY).toBe(FIXED_SECRETS.FIXED_API_KEY);
    expect(vars.FIXED_DATABASE_URL).toBe(FIXED_SECRETS.FIXED_DATABASE_URL);
  });
});
