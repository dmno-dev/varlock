import {
  afterEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-set';
const FIXTURE_DIR = 'smoke-test-keychain-set';
const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_PATH = join(SMOKE_TESTS_DIR, FIXTURE_DIR);
const ACCOUNT = 'set:SECRET_FROM_KEYCHAIN';
const createdAccounts: Array<string> = [];

function uniqueId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function runVarlockWithInput(args: Array<string>, input: string) {
  const result = spawnSync(process.execPath, [VARLOCK_CLI, ...args], {
    cwd: FIXTURE_PATH,
    env: { ...process.env },
    input,
    encoding: 'utf-8',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

function runVarlock(args: Array<string>) {
  return runVarlockWithInput(args, '');
}

afterEach(() => {
  for (const account of createdAccounts.splice(0)) {
    security(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain set smoke tests', () => {
  test('stores stdin secret and reads it through the persistent keychain ref', () => {
    const account = ACCOUNT;
    const secret = `keychain-set-smoke-secret-${uniqueId()}`;
    createdAccounts.push(account);

    const beforeSetResult = runVarlock(['printenv', 'SECRET_FROM_KEYCHAIN', '--skip-cache']);
    expect(beforeSetResult.exitCode, beforeSetResult.output).not.toBe(0);

    const setResult = runVarlockWithInput([
      'keychain',
      'set',
      'SECRET_FROM_KEYCHAIN',
      '--service',
      SERVICE,
      '--account',
      account,
      '--force',
    ], `${secret}\n`);
    expect(setResult.exitCode, setResult.output).toBe(0);
    expect(setResult.output).toContain('Stored SECRET_FROM_KEYCHAIN in macOS Keychain.');
    expect(setResult.output).not.toContain(secret);

    const listResult = runVarlock(['keychain', 'list', account]);
    expect(listResult.exitCode, listResult.output).toBe(0);
    expect(listResult.output).toContain(SERVICE);
    expect(listResult.output).toContain(account);
    expect(listResult.output).not.toContain(secret);

    const printenvResult = runVarlock(['printenv', 'SECRET_FROM_KEYCHAIN', '--skip-cache']);
    expect(printenvResult.exitCode, printenvResult.output).toBe(0);
    expect(printenvResult.stdout.trim()).toBe(secret);

    const loadResult = runVarlock(['load', '--format', 'json', '--skip-cache']);
    expect(loadResult.exitCode, loadResult.output).toBe(0);
    const vars = JSON.parse(loadResult.stdout);
    expect(vars.SECRET_FROM_KEYCHAIN).toBe(secret);
  });
});
