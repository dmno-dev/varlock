import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { assertKeychainHelperSigned } from '../helpers/keychain-signature-preflight.js';
import { runVarlock as runVarlockHelper } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-set';
const FIXTURE_DIR = 'smoke-test-keychain-set';
const ACCOUNT = 'set:SECRET_FROM_KEYCHAIN';

function uniqueId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/** Fixture cleanup goes through /usr/bin/security so it still works when varlock itself is broken */
function deleteFixtureItem() {
  spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { encoding: 'utf-8' });
}

function runVarlock(args: Array<string>, input = '') {
  return runVarlockHelper(args, { cwd: FIXTURE_DIR, input });
}

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain set/delete smoke tests', () => {
  // Restart the daemon once per file, not per test: each fresh daemon costs a Touch ID prompt
  beforeAll(() => {
    assertKeychainHelperSigned();
    resetVarlockDaemon();
  });

  afterAll(() => {
    resetVarlockDaemon();
  });

  beforeEach(() => {
    deleteFixtureItem();
  });

  afterEach(() => {
    deleteFixtureItem();
  });

  test('stores stdin secret and reads it through the persistent keychain ref', () => {
    const secret = `keychain-set-smoke-secret-${uniqueId()}`;

    const beforeSetResult = runVarlock(['load', '--skip-cache']);
    expect(beforeSetResult.exitCode, beforeSetResult.output).not.toBe(0);
    expect(beforeSetResult.output).toContain('Keychain item not found');
    expect(beforeSetResult.output).toContain(`varlock keychain set SECRET_FROM_KEYCHAIN --service ${SERVICE} --account ${ACCOUNT}`);

    const setResult = runVarlock([
      'keychain',
      'set',
      'SECRET_FROM_KEYCHAIN',
      '--service',
      SERVICE,
      '--account',
      ACCOUNT,
      '--force',
    ], `${secret}\n`);
    expect(setResult.exitCode, setResult.output).toBe(0);
    expect(setResult.output).toContain('Stored SECRET_FROM_KEYCHAIN in macOS Keychain.');
    expect(setResult.output).not.toContain(secret);

    const listResult = runVarlock(['keychain', 'list', ACCOUNT]);
    expect(listResult.exitCode, listResult.output).toBe(0);
    expect(listResult.output).toContain(SERVICE);
    expect(listResult.output).toContain(ACCOUNT);
    expect(listResult.output).not.toContain(secret);

    const printenvResult = runVarlock(['printenv', 'SECRET_FROM_KEYCHAIN', '--skip-cache']);
    expect(printenvResult.exitCode, printenvResult.output).toBe(0);
    expect(printenvResult.stdout.trim()).toBe(secret);

    const loadResult = runVarlock(['load', '--format', 'json', '--skip-cache']);
    expect(loadResult.exitCode, loadResult.output).toBe(0);
    const vars = JSON.parse(loadResult.stdout);
    expect(vars.SECRET_FROM_KEYCHAIN).toBe(secret);
  });

  test('deletes an item created by set', () => {
    const setResult = runVarlock([
      'keychain',
      'set',
      'SECRET_FROM_KEYCHAIN',
      '--service',
      SERVICE,
      '--account',
      ACCOUNT,
      '--force',
    ], `keychain-delete-smoke-secret-${uniqueId()}\n`);
    expect(setResult.exitCode, setResult.output).toBe(0);

    const deleteResult = runVarlock(['keychain', 'delete', '--service', SERVICE, '--account', ACCOUNT]);
    expect(deleteResult.exitCode, deleteResult.output).toBe(0);

    const afterDeleteResult = runVarlock(['printenv', 'SECRET_FROM_KEYCHAIN', '--skip-cache']);
    expect(afterDeleteResult.exitCode, afterDeleteResult.output).not.toBe(0);

    const deleteAgainResult = runVarlock(['keychain', 'delete', '--service', SERVICE, '--account', ACCOUNT]);
    expect(deleteAgainResult.exitCode, deleteAgainResult.output).not.toBe(0);
  });
});
