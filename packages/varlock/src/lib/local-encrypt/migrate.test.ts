/**
 * Tests for `varlock migrate` (migrate.ts) on the file backend.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEVICE_PAYLOAD_VERSION, IDENTITY_PAYLOAD_VERSION, readPayloadVersion } from './crypto';
import { parseVarlockReference } from './reference';

process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';

const testDir = path.join(os.tmpdir(), `varlock-migrate-test-${process.pid}`);
const projectDir = path.join(testDir, 'project');

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => path.join(testDir, 'state'),
}));

let localEncrypt: typeof import('./index');
let migrate: typeof import('./migrate');

/** Read the payload version of `KEY=varlock("local:...")` in a file */
function payloadVersionOf(contents: string, key: string) {
  const match = new RegExp(`^${key}=varlock\\("([^"]+)"\\)$`, 'm').exec(contents);
  if (!match) throw new Error(`no varlock() reference found for ${key}`);
  return readPayloadVersion(parseVarlockReference(match[1]).payload);
}

beforeEach(async () => {
  fs.mkdirSync(projectDir, { recursive: true });
  vi.resetModules();
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
  delete process.env._VARLOCK_DISABLE_IDENTITY;
  localEncrypt = await import('./index');
  migrate = await import('./migrate');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env._VARLOCK_DISABLE_IDENTITY;
});

/** Write a fixture env file with two device-encrypted values and assorted noise */
async function writeFixture() {
  await localEncrypt.ensureKey();
  const apiKey = await localEncrypt.encryptValue('sk-live-1234', undefined, { target: 'device' });
  const dbUrl = await localEncrypt.encryptValue('postgres://localhost/db', undefined, { target: 'device' });
  const alreadyMigrated = await localEncrypt.encryptValue('already-v2');

  const contents = [
    '# @envFlag=APP_ENV',
    '# ---',
    '',
    '# @sensitive',
    `API_KEY=varlock("local:${apiKey}")`,
    '',
    '# a plain value nobody should touch',
    'PUBLIC_URL=https://example.com',
    '',
    '# @sensitive',
    `DATABASE_URL=varlock("local:${dbUrl}")`,
    '',
    '# @sensitive',
    `ALREADY=varlock("local:${alreadyMigrated}")`,
    '',
    '# @sensitive',
    'NEEDS_INPUT=varlock(prompt=1)',
    '',
  ].join('\n');

  const filePath = path.join(projectDir, '.env.local');
  fs.writeFileSync(filePath, contents);
  return { filePath, contents, plaintexts: { API_KEY: 'sk-live-1234', DATABASE_URL: 'postgres://localhost/db' } };
}

describe('migrateFileToIdentity', () => {
  it('rewrites v1 values as v2 and leaves the rest alone', async () => {
    const { filePath, contents: before } = await writeFixture();

    const result = await migrate.migrateFileToIdentity(filePath);
    expect(result.migrated.sort()).toEqual(['API_KEY', 'DATABASE_URL']);

    const after = fs.readFileSync(filePath, 'utf-8');
    expect(payloadVersionOf(after, 'API_KEY')).toBe(IDENTITY_PAYLOAD_VERSION);
    expect(payloadVersionOf(after, 'DATABASE_URL')).toBe(IDENTITY_PAYLOAD_VERSION);

    // Every line except the two that were migrated comes through byte for byte,
    // in the same order. (The shared write-back path normalizes blank lines, so
    // those are compared out.)
    const meaningfulLines = (contents: string) => contents.split('\n').filter((l) => l.trim() !== '');
    const beforeLines = meaningfulLines(before);
    const afterLines = meaningfulLines(after);
    expect(afterLines).toHaveLength(beforeLines.length);

    const migratedKeys = ['API_KEY', 'DATABASE_URL'];
    const isMigratedLine = (line: string) => migratedKeys.some((k) => line.startsWith(`${k}=`));
    for (let i = 0; i < beforeLines.length; i++) {
      if (isMigratedLine(beforeLines[i])) {
        expect(afterLines[i]).not.toBe(beforeLines[i]);
      } else {
        expect(afterLines[i]).toBe(beforeLines[i]);
      }
    }
  });

  it('preserves the decrypted values', async () => {
    const { filePath, plaintexts } = await writeFixture();
    await migrate.migrateFileToIdentity(filePath);

    const after = fs.readFileSync(filePath, 'utf-8');
    for (const [key, expected] of Object.entries(plaintexts)) {
      const match = new RegExp(`^${key}=varlock\\("([^"]+)"\\)$`, 'm').exec(after)!;
      const { payload } = parseVarlockReference(match[1]);

      expect(await localEncrypt.decryptValue(payload)).toBe(expected);
    }
  });

  it('leaves values that are already identity-encrypted', async () => {
    const { filePath, contents: before } = await writeFixture();
    const result = await migrate.migrateFileToIdentity(filePath);

    expect(result.skipped).toContainEqual({ key: 'ALREADY', reason: 'already-identity-encrypted' });

    const beforeAlready = /^ALREADY=(.*)$/m.exec(before)![1];
    const afterAlready = /^ALREADY=(.*)$/m.exec(fs.readFileSync(filePath, 'utf-8'))![1];
    expect(afterAlready).toBe(beforeAlready);
  });

  it('skips prompt entries, which carry no payload', async () => {
    const { filePath } = await writeFixture();
    const result = await migrate.migrateFileToIdentity(filePath);
    expect(result.skipped).toContainEqual({ key: 'NEEDS_INPUT', reason: 'not-a-static-payload' });
  });

  it('is a no-op on a second run', async () => {
    const { filePath } = await writeFixture();
    await migrate.migrateFileToIdentity(filePath);
    const afterFirst = fs.readFileSync(filePath, 'utf-8');

    const second = await migrate.migrateFileToIdentity(filePath);
    expect(second.migrated).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(afterFirst);
  });

  it('changes nothing on a dry run', async () => {
    const { filePath, contents: before } = await writeFixture();

    const result = await migrate.migrateFileToIdentity(filePath, { dryRun: true });
    expect(result.migrated.sort()).toEqual(['API_KEY', 'DATABASE_URL']);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('leaves references from another scheme alone', async () => {
    await localEncrypt.ensureKey();
    const filePath = path.join(projectDir, '.env.other');
    const contents = 'TEAM_SECRET=varlock("teamvault:AQIDBA==")\n';
    fs.writeFileSync(filePath, contents);

    const result = await migrate.migrateFileToIdentity(filePath);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toContainEqual({ key: 'TEAM_SECRET', reason: 'unknown-scheme' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(contents);
  });
});

describe('canMigrateToIdentity', () => {
  it('allows migration on the file backend', () => {
    expect(migrate.canMigrateToIdentity()).toEqual({ ok: true });
  });

  it('refuses when the identity layer is switched off', async () => {
    process.env._VARLOCK_DISABLE_IDENTITY = '1';
    const result = migrate.canMigrateToIdentity();
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/identity layer is disabled/);

    // and nothing gets rewritten
    const { filePath, contents: before } = await writeFixture();
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    expect(payloadVersionOf(before, 'API_KEY')).toBe(DEVICE_PAYLOAD_VERSION);
  });
});
