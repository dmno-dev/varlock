import {
  afterEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test';
const FIXTURE_DIR = 'smoke-test-keychain';
const FIXTURE_SCHEMA_PATH = join(import.meta.dirname, '..', FIXTURE_DIR, '.env.schema');
const createdAccounts: Array<string> = [];

function uniqueId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
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
  createdAccounts.push(account);
}

function writeKeychainFixture(account: string) {
  writeFileSync(FIXTURE_SCHEMA_PATH, [
    '# @defaultSensitive=false',
    '# ---',
    '',
    '# @sensitive',
    `SECRET_FROM_KEYCHAIN=keychain(service="${SERVICE}", account="${account}")`,
    '',
  ].join('\n'));
}

function clearKeychainFixture() {
  writeFileSync(FIXTURE_SCHEMA_PATH, '');
}

afterEach(() => {
  for (const account of createdAccounts.splice(0)) {
    security(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
  clearKeychainFixture();
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain smoke tests', () => {
  test('lists, resolves when already allowed, or fixes access before resolving a keychain item', () => {
    const account = `node:${uniqueId()}:SECRET_FROM_KEYCHAIN`;
    const secret = `keychain-smoke-secret-${uniqueId()}`;
    createKeychainItem(account, secret);
    writeKeychainFixture(account);

    const listResult = runVarlock(['keychain', 'list', account]);
    expect(listResult.exitCode, listResult.output).toBe(0);
    expect(listResult.output).toContain(SERVICE);
    expect(listResult.output).toContain(account);

    const initialLoadResult = runVarlock(['load', '--format', 'json', '--skip-cache'], {
      cwd: FIXTURE_DIR,
    });

    if (initialLoadResult.exitCode === 0) {
      const vars = JSON.parse(initialLoadResult.stdout);
      expect(vars.SECRET_FROM_KEYCHAIN).toBe(secret);
      return;
    }

    const fixAccessResult = runVarlock([
      'keychain',
      'fix-access',
      '--service',
      SERVICE,
      '--account',
      account,
    ]);
    expect(fixAccessResult.exitCode, fixAccessResult.output).toBe(0);

    const loadAfterFixResult = runVarlock(['load', '--format', 'json', '--skip-cache'], {
      cwd: FIXTURE_DIR,
    });
    expect(loadAfterFixResult.exitCode, loadAfterFixResult.output).toBe(0);
    const vars = JSON.parse(loadAfterFixResult.stdout);
    expect(vars.SECRET_FROM_KEYCHAIN).toBe(secret);
  });
});
