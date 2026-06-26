import {
  afterEach, describe, expect, test,
} from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VARLOCK_CLI } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-deno';
const createdAccounts: Array<string> = [];

function hasDeno(): boolean {
  try {
    execSync('deno --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function uniqueId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function runDenoVarlock(args: Array<string>, options?: {
  cwd?: string;
  env?: Record<string, string>;
}) {
  const env = { ...process.env, ...options?.env };
  const result = spawnSync('deno', ['run', '-A', VARLOCK_CLI, ...args], {
    cwd: options?.cwd,
    env,
    encoding: 'utf-8',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
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
  const dir = mkdtempSync(join(tmpdir(), 'varlock-keychain-deno-smoke-'));
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

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin' || !hasDeno())('Deno macOS Keychain smoke tests', () => {
  test('lists, fixes access for, and resolves a keychain item through deno run -A', () => {
    const account = `deno:${uniqueId()}:SECRET_FROM_KEYCHAIN`;
    const secret = `keychain-deno-smoke-secret-${uniqueId()}`;
    createKeychainItem(account, secret);
    const fixtureDir = createKeychainFixture(account);

    try {
      const listResult = runDenoVarlock(['keychain', 'list', account]);
      expect(listResult.exitCode, listResult.output).toBe(0);
      expect(listResult.output).toContain(SERVICE);
      expect(listResult.output).toContain(account);

      const fixAccessResult = runDenoVarlock([
        'keychain',
        'fix-access',
        '--service',
        SERVICE,
        '--account',
        account,
      ]);
      expect(fixAccessResult.exitCode, fixAccessResult.output).toBe(0);

      const loadResult = runDenoVarlock(['load', '--format', 'json', '--skip-cache'], {
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
