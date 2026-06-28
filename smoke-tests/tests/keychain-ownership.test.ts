import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-ownership';
const PROFILE = 'local';
const PROJECT = 'smoke-test-keychain-ownership';
const FIXTURE_DIR = PROJECT;
const FIXTURE_SCHEMA = '.env.schema';
const OWNED_SECRETS = {
  OWNED_API_KEY: 'owned-api-key-from-keychain',
};
const OWNED_ACCOUNTS = Object.keys(OWNED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:${key}`);

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function deleteOwnedSecrets() {
  for (const account of OWNED_ACCOUNTS) {
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
  deleteOwnedSecrets();
  for (const [key, value] of Object.entries(OWNED_SECRETS)) {
    createKeychainItem(`${PROJECT}:${PROFILE}:${key}`, value);
  }
});

afterEach(() => {
  deleteOwnedSecrets();
  resetVarlockDaemon();
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain take-ownership smoke tests', () => {
  test('takes ownership for keychain refs and reads the secrets', () => {
    const takeOwnershipResult = runVarlock([
      'keychain',
      'take-ownership',
      '--path',
      FIXTURE_SCHEMA,
    ], { cwd: FIXTURE_DIR });
    expect(takeOwnershipResult.exitCode, takeOwnershipResult.output).toBe(0);

    const loadAfterOwnershipResult = runVarlock(['load', '--format', 'json', '--skip-cache'], {
      cwd: FIXTURE_DIR,
    });
    expect(loadAfterOwnershipResult.exitCode, loadAfterOwnershipResult.output).toBe(0);
    const vars = JSON.parse(loadAfterOwnershipResult.stdout);
    expect(vars.OWNED_API_KEY).toBe(OWNED_SECRETS.OWNED_API_KEY);
  });
});
