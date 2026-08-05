import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resetVarlockDaemon } from '../helpers/keychain-daemon.js';
import { runVarlock } from '../helpers/run-varlock.js';

const RUN_KEYCHAIN_SMOKE = process.env.VARLOCK_RUN_KEYCHAIN_SMOKE === '1';
const SERVICE = 'varlock-smoke-test-import';
const PROFILE = 'local';
const PROJECT = 'smoke-test-keychain-import';
const FIXTURE_DIR = PROJECT;
const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');
const FIXTURE_PATH = join(SMOKE_TESTS_DIR, FIXTURE_DIR);
const ENV_PATH = join(FIXTURE_PATH, '.env');
const ORIGINAL_ENV = [
  'OLD_API_KEY=old-api-key-from-dotenv',
  'OLD_DATABASE_URL=postgres://old-user:old-pass@localhost:5432/old-db',
  '',
].join('\n');
const IMPORTED_SECRETS = {
  OLD_API_KEY: 'old-api-key-from-dotenv',
  OLD_DATABASE_URL: 'postgres://old-user:old-pass@localhost:5432/old-db',
};
const IMPORTED_ACCOUNTS = Object.keys(IMPORTED_SECRETS).map((key) => `${PROJECT}:${PROFILE}:${key}`);

function security(args: Array<string>) {
  return spawnSync('security', args, { encoding: 'utf-8' });
}

function deleteImportedSecrets() {
  for (const account of IMPORTED_ACCOUNTS) {
    security(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
}

beforeEach(() => {
  resetVarlockDaemon();
  deleteImportedSecrets();
  writeFileSync(ENV_PATH, ORIGINAL_ENV);
});

afterEach(() => {
  writeFileSync(ENV_PATH, ORIGINAL_ENV);
  deleteImportedSecrets();
  resetVarlockDaemon();
});

describe.skipIf(!RUN_KEYCHAIN_SMOKE || process.platform !== 'darwin')('macOS Keychain import smoke tests', () => {
  test('imports sensitive plaintext env values and reads them back from keychain refs', () => {
    const importResult = runVarlock([
      'keychain',
      'import',
      '.env',
      '--service',
      SERVICE,
      '--profile',
      PROFILE,
      '--project',
      PROJECT,
    ], { cwd: FIXTURE_DIR });
    expect(importResult.exitCode, importResult.output).toBe(0);
    expect(importResult.output).toContain('Imported OLD_API_KEY');
    expect(importResult.output).toContain('Imported OLD_DATABASE_URL');
    expect(importResult.output).toContain('Imported 2 sensitive values into macOS Keychain.');
    expect(importResult.output).not.toContain(IMPORTED_SECRETS.OLD_API_KEY);
    expect(importResult.output).not.toContain(IMPORTED_SECRETS.OLD_DATABASE_URL);

    const importedEnv = readFileSync(ENV_PATH, 'utf-8');
    expect(importedEnv).toContain(`OLD_API_KEY=keychain(service="${SERVICE}", account="${PROJECT}:${PROFILE}:OLD_API_KEY")`);
    expect(importedEnv).toContain(`OLD_DATABASE_URL=keychain(service="${SERVICE}", account="${PROJECT}:${PROFILE}:OLD_DATABASE_URL")`);
    expect(importedEnv).not.toContain(IMPORTED_SECRETS.OLD_API_KEY);
    expect(importedEnv).not.toContain(IMPORTED_SECRETS.OLD_DATABASE_URL);

    unlinkSync(ENV_PATH);
    expect(existsSync(ENV_PATH)).toBe(false);

    const apiKeyResult = runVarlock(['printenv', 'OLD_API_KEY', '--skip-cache'], { cwd: FIXTURE_DIR });
    expect(apiKeyResult.exitCode, apiKeyResult.output).toBe(0);
    expect(apiKeyResult.stdout.trim()).toBe(IMPORTED_SECRETS.OLD_API_KEY);

    const databaseUrlResult = runVarlock(['printenv', 'OLD_DATABASE_URL', '--skip-cache'], { cwd: FIXTURE_DIR });
    expect(databaseUrlResult.exitCode, databaseUrlResult.output).toBe(0);
    expect(databaseUrlResult.stdout.trim()).toBe(IMPORTED_SECRETS.OLD_DATABASE_URL);

    const loadResult = runVarlock(['load', '--format', 'json', '--skip-cache'], { cwd: FIXTURE_DIR });
    expect(loadResult.exitCode, loadResult.output).toBe(0);
    const vars = JSON.parse(loadResult.stdout);
    expect(vars.OLD_API_KEY).toBe(IMPORTED_SECRETS.OLD_API_KEY);
    expect(vars.OLD_DATABASE_URL).toBe(IMPORTED_SECRETS.OLD_DATABASE_URL);
  });
});
