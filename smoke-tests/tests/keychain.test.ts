import {
  afterEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test';
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

function createKeychainFixture(account: string) {
  const dir = mkdtempSync(join(tmpdir(), 'varlock-keychain-smoke-'));
  writeFileSync(join(dir, '.env.schema'), [
    '# @defaultSensitive=false',
    '# ---',
    '',
    '# @sensitive',
    `SECRET_FROM_KEYCHAIN=keychain(service="${SERVICE}", account="${account}")`,
    '',
  ].join('\n'));
  return dir;
}

afterEach(() => {
  for (const account of createdAccounts.splice(0)) {
    security(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain smoke tests', () => {
  test('lists, fixes access for, and resolves a keychain item', () => {
    const account = `node:${uniqueId()}:SECRET_FROM_KEYCHAIN`;
    const secret = `keychain-smoke-secret-${uniqueId()}`;
    createKeychainItem(account, secret);
    const fixtureDir = createKeychainFixture(account);

    try {
      const listResult = runVarlock(['keychain', 'list', account]);
      expect(listResult.exitCode, listResult.output).toBe(0);
      expect(listResult.output).toContain(SERVICE);
      expect(listResult.output).toContain(account);

      const fixAccessResult = runVarlock([
        'keychain',
        'fix-access',
        '--service',
        SERVICE,
        '--account',
        account,
      ]);
      expect(fixAccessResult.exitCode, fixAccessResult.output).toBe(0);

      const loadResult = runVarlock(['load', '--format', 'json', '--skip-cache'], {
        cwd: fixtureDir,
      });
      expect(loadResult.exitCode, loadResult.output).toBe(0);
      const vars = JSON.parse(loadResult.stdout);
      expect(vars.SECRET_FROM_KEYCHAIN).toBe(secret);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
