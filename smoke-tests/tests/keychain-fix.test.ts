import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE_PREFIX = 'varlock-smoke-test-fix';
const PROFILE = 'local';
const PROJECT = 'smoke-test-keychain-fix';
const FIXTURE_DIR = PROJECT;
const FIXTURE_SCHEMA = '.env.keychainfix.schema';
const FIXTURE_SCHEMA_PATH = join(import.meta.dirname, '..', FIXTURE_DIR, FIXTURE_SCHEMA);
const FIXED_SECRETS = {
  FIXED_API_KEY: 'fixed-api-key-from-keychain',
  FIXED_DATABASE_URL: 'postgres://fixed-user:fixed-pass@localhost:5432/fixed-db',
};
const FIXED_ACCOUNTS = Object.keys(FIXED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:${key}`);
let cleanupWithVarlockDaemon = false;
let service = SERVICE_PREFIX;

function phase(message: string) {
  console.error(`[keychain-fix smoke] PHASE: ${message}`);
}

function uniqueService() {
  const suffix = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return `${SERVICE_PREFIX}-${suffix}`;
}

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function writeGeneratedSchema() {
  const apiAccount = `${PROJECT}:${PROFILE}:FIXED_API_KEY`;
  const databaseAccount = `${PROJECT}:${PROFILE}:FIXED_DATABASE_URL`;
  writeFileSync(FIXTURE_SCHEMA_PATH, [
    '# @defaultSensitive=false',
    '# ---',
    '',
    '# @sensitive',
    `FIXED_API_KEY=keychain(service="${service}", account="${apiAccount}", useFallback=false)`,
    '',
    '# @sensitive',
    `FIXED_DATABASE_URL=keychain(service="${service}", account="${databaseAccount}", useFallback=false)`,
    '',
  ].join('\n'));
}

function removeGeneratedSchema() {
  try {
    unlinkSync(FIXTURE_SCHEMA_PATH);
  } catch {
    // Already gone.
  }
}

function deleteFixedSecretsWithSecurity(reason: string) {
  phase(`${reason}: delete fixture items for service ${service} via /usr/bin/security`);
  for (const account of FIXED_ACCOUNTS) {
    security(['delete-generic-password', '-s', service, '-a', account]);
  }
}

function deleteFixedSecretsWithVarlockDaemon(reason: string) {
  phase(`${reason}: delete fixture items for service ${service} via Varlock daemon`);
  const failures: Array<string> = [];
  for (const account of FIXED_ACCOUNTS) {
    const result = runVarlock([
      'keychain',
      'delete',
      '--service',
      service,
      '--account',
      account,
    ], { cwd: FIXTURE_DIR });
    if (result.exitCode !== 0) failures.push(result.output);
  }
  if (failures.length > 0) {
    deleteFixedSecretsWithSecurity(`${reason} fallback after Varlock daemon cleanup failed`);
  }
  expect(failures.join('\n')).toBe('');
}

function createKeychainItem(key: string, account: string, value: string) {
  phase(`beforeEach: create restricted Keychain item for ${key} via /usr/bin/security`);
  const result = security([
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    account,
    '-l',
    `VARLOCK SMOKE keychain-fix beforeEach target: ${key}`,
    '-j',
    'Created by smoke-tests/tests/keychain-fix.test.ts beforeEach. Successful cleanup should use Varlock daemon; failed/pre-test cleanup uses /usr/bin/security.',
    '-D',
    'Varlock keychain-fix smoke test restricted generic password',
    '-w',
    value,
    '-T',
    '',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

beforeEach(() => {
  cleanupWithVarlockDaemon = false;
  service = uniqueService();
  phase(`beforeEach: reset Varlock daemon for service ${service}`);
  resetVarlockDaemon();
  writeGeneratedSchema();
  for (const [key, value] of Object.entries(FIXED_SECRETS)) {
    createKeychainItem(key, `${PROJECT}:${PROFILE}:${key}`, value);
  }
});

afterEach(() => {
  try {
    if (cleanupWithVarlockDaemon) {
      deleteFixedSecretsWithVarlockDaemon('afterEach successful fix-access cleanup');
    } else {
      deleteFixedSecretsWithSecurity('afterEach failed/pre-fix cleanup');
    }
  } finally {
    removeGeneratedSchema();
    phase('afterEach: reset Varlock daemon');
    resetVarlockDaemon();
  }
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain fix-access smoke tests', () => {
  test('fixes access for keychain refs in the fixture schema and reads the secrets', () => {
    phase('test: run varlock keychain fix-access');
    const fixAccessResult = runVarlock([
      'keychain',
      'fix-access',
      '--path',
      FIXTURE_SCHEMA,
    ], { cwd: FIXTURE_DIR });
    expect(fixAccessResult.exitCode, fixAccessResult.output).toBe(0);

    phase('test: printenv FIXED_API_KEY after fix-access');
    const apiKeyResult = runVarlock(['printenv', 'FIXED_API_KEY', '--skip-cache', '--path', FIXTURE_SCHEMA], { cwd: FIXTURE_DIR });
    expect(apiKeyResult.exitCode, apiKeyResult.output).toBe(0);
    expect(apiKeyResult.stdout.trim()).toBe(FIXED_SECRETS.FIXED_API_KEY);

    phase('test: printenv FIXED_DATABASE_URL after fix-access');
    const databaseUrlResult = runVarlock(['printenv', 'FIXED_DATABASE_URL', '--skip-cache', '--path', FIXTURE_SCHEMA], { cwd: FIXTURE_DIR });
    expect(databaseUrlResult.exitCode, databaseUrlResult.output).toBe(0);
    expect(databaseUrlResult.stdout.trim()).toBe(FIXED_SECRETS.FIXED_DATABASE_URL);

    phase('test: load after fix-access');
    const loadAfterFixResult = runVarlock(['load', '--format', 'json', '--skip-cache', '--path', FIXTURE_SCHEMA], {
      cwd: FIXTURE_DIR,
    });
    expect(loadAfterFixResult.exitCode, loadAfterFixResult.output).toBe(0);
    const vars = JSON.parse(loadAfterFixResult.stdout);
    expect(vars.FIXED_API_KEY).toBe(FIXED_SECRETS.FIXED_API_KEY);
    expect(vars.FIXED_DATABASE_URL).toBe(FIXED_SECRETS.FIXED_DATABASE_URL);
    cleanupWithVarlockDaemon = true;
  });
});
