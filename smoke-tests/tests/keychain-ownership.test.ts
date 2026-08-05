import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SOURCE_SERVICE = 'varlock-smoke-test-ownership-source';
const TARGET_SERVICE = 'varlock-smoke-test-ownership';
const PROFILE = 'local';
const PROJECT = 'smoke-test-keychain-ownership';
const FIXTURE_DIR = PROJECT;
const WRITTEN_ENV = '.env.cloned';
const WRITTEN_ENV_PATH = join(import.meta.dirname, '..', FIXTURE_DIR, WRITTEN_ENV);
const OWNED_SECRETS = {
  OWNED_API_KEY: 'owned-api-key-from-keychain',
};
const SOURCE_ACCOUNTS = Object.keys(OWNED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:source:${key}`);
const TARGET_ACCOUNTS = Object.keys(OWNED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:${key}`);

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function deleteOwnedSecrets() {
  for (const account of SOURCE_ACCOUNTS) {
    security(['delete-generic-password', '-s', SOURCE_SERVICE, '-a', account]);
  }
  for (const account of TARGET_ACCOUNTS) {
    security(['delete-generic-password', '-s', TARGET_SERVICE, '-a', account]);
  }
}

function createKeychainItem(account: string, value: string) {
  const result = security([
    'add-generic-password',
    '-U',
    '-s',
    SOURCE_SERVICE,
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
    createKeychainItem(`${PROJECT}:${PROFILE}:source:${key}`, value);
  }
});

afterEach(() => {
  if (existsSync(WRITTEN_ENV_PATH)) unlinkSync(WRITTEN_ENV_PATH);
  deleteOwnedSecrets();
  resetVarlockDaemon();
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain cloneToOwned smoke tests', () => {
  test('clones one source secret into a Varlock-owned item and reads it', () => {
    const cloneResult = runVarlock([
      'keychain',
      'cloneToOwned',
      '--service',
      SOURCE_SERVICE,
      '--account',
      `${PROJECT}:${PROFILE}:source:OWNED_API_KEY`,
      '--target-service',
      TARGET_SERVICE,
      '--target-account',
      `${PROJECT}:${PROFILE}:OWNED_API_KEY`,
      '--write-to',
      WRITTEN_ENV,
      '--key',
      'OWNED_API_KEY',
    ], { cwd: FIXTURE_DIR });
    expect(cloneResult.exitCode, cloneResult.output).toBe(0);

    const loadAfterCloneResult = runVarlock(['load', '--format', 'json', '--skip-cache', '--path', WRITTEN_ENV], {
      cwd: FIXTURE_DIR,
    });
    expect(loadAfterCloneResult.exitCode, loadAfterCloneResult.output).toBe(0);
    const vars = JSON.parse(loadAfterCloneResult.stdout);
    expect(vars.OWNED_API_KEY).toBe(OWNED_SECRETS.OWNED_API_KEY);
  });
});
