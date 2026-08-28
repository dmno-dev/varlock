/**
 * Tests for the re-encryption core (re-encrypt.ts) on the file backend.
 * This is what `varlock encrypt --upgrade` drives.
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

const testDir = path.join(os.tmpdir(), `varlock-re-encrypt-test-${process.pid}`);
const projectDir = path.join(testDir, 'project');

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => path.join(testDir, 'state'),
}));

let localEncrypt: typeof import('./index');
let reEncrypt: typeof import('./re-encrypt');

/** Read the payload version of `KEY=varlock("local:...")` in a file */
function payloadVersionOf(contents: string, key: string) {
  const match = new RegExp(`^${key}=varlock\\("([^"]+)"\\)$`, 'm').exec(contents);
  if (!match) throw new Error(`no varlock() reference found for ${key}`);
  return readPayloadVersion(parseVarlockReference(match[1]).payload);
}

/** The default local pass: device-encrypted values move to the current target */
function localUpgradePass() {
  return { source: reEncrypt.deviceEncryptedSource(), target: reEncrypt.currentLocalTarget() };
}

/** Run the default local upgrade pass against a file */
function reEncryptFileWithDefaults(filePath: string) {
  return reEncrypt.reEncryptFile(filePath, localUpgradePass());
}

beforeEach(async () => {
  fs.mkdirSync(projectDir, { recursive: true });
  vi.resetModules();
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
  localEncrypt = await import('./index');
  reEncrypt = await import('./re-encrypt');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Write a fixture env file with two device-encrypted values and assorted noise */
async function writeFixture() {
  await localEncrypt.ensureKey();
  const apiKey = await localEncrypt.encryptValue('sk-live-1234', undefined, { target: 'device' });
  const dbUrl = await localEncrypt.encryptValue('postgres://localhost/db', undefined, { target: 'device' });
  const alreadyUpgraded = await localEncrypt.encryptValue('already-v2');

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
    `ALREADY=varlock("local:${alreadyUpgraded}")`,
    '',
    '# @sensitive',
    'NEEDS_INPUT=varlock(prompt=1)',
    '',
  ].join('\n');

  const filePath = path.join(projectDir, '.env.local');
  fs.writeFileSync(filePath, contents);
  return { filePath, contents, plaintexts: { API_KEY: 'sk-live-1234', DATABASE_URL: 'postgres://localhost/db' } };
}

describe('reEncryptFile', () => {
  it('rewrites v1 values to the current target and leaves the rest alone', async () => {
    const { filePath, contents: before } = await writeFixture();

    const result = await reEncryptFileWithDefaults(filePath);
    expect(result.reEncrypted.sort()).toEqual(['API_KEY', 'DATABASE_URL']);

    const after = fs.readFileSync(filePath, 'utf-8');
    expect(payloadVersionOf(after, 'API_KEY')).toBe(IDENTITY_PAYLOAD_VERSION);
    expect(payloadVersionOf(after, 'DATABASE_URL')).toBe(IDENTITY_PAYLOAD_VERSION);

    // Every line except the two that changed comes through byte for byte, in
    // the same order. (The shared write-back path normalizes blank lines, so
    // those are compared out.)
    const meaningfulLines = (contents: string) => contents.split('\n').filter((l) => l.trim() !== '');
    const beforeLines = meaningfulLines(before);
    const afterLines = meaningfulLines(after);
    expect(afterLines).toHaveLength(beforeLines.length);

    const changedKeys = ['API_KEY', 'DATABASE_URL'];
    const isChangedLine = (line: string) => changedKeys.some((k) => line.startsWith(`${k}=`));
    for (let i = 0; i < beforeLines.length; i++) {
      if (isChangedLine(beforeLines[i])) {
        expect(afterLines[i]).not.toBe(beforeLines[i]);
      } else {
        expect(afterLines[i]).toBe(beforeLines[i]);
      }
    }
  });

  it('preserves the decrypted values', async () => {
    const { filePath, plaintexts } = await writeFixture();
    await reEncryptFileWithDefaults(filePath);

    const after = fs.readFileSync(filePath, 'utf-8');
    for (const [key, expected] of Object.entries(plaintexts)) {
      const match = new RegExp(`^${key}=varlock\\("([^"]+)"\\)$`, 'm').exec(after)!;
      const { payload } = parseVarlockReference(match[1]);

      expect(await localEncrypt.decryptValue(payload)).toBe(expected);
    }
  });

  it('leaves values that are already at the target', async () => {
    const { filePath, contents: before } = await writeFixture();
    const result = await reEncryptFileWithDefaults(filePath);

    expect(result.skipped).toContainEqual({ key: 'ALREADY', reason: 'not-a-source-value' });

    const beforeAlready = /^ALREADY=(.*)$/m.exec(before)![1];
    const afterAlready = /^ALREADY=(.*)$/m.exec(fs.readFileSync(filePath, 'utf-8'))![1];
    expect(afterAlready).toBe(beforeAlready);
  });

  it('skips prompt entries, which carry no payload', async () => {
    const { filePath } = await writeFixture();
    const result = await reEncryptFileWithDefaults(filePath);
    expect(result.skipped).toContainEqual({ key: 'NEEDS_INPUT', reason: 'not-a-static-payload' });
  });

  it('is a no-op on a second run', async () => {
    const { filePath } = await writeFixture();
    await reEncryptFileWithDefaults(filePath);
    const afterFirst = fs.readFileSync(filePath, 'utf-8');

    const second = await reEncryptFileWithDefaults(filePath);
    expect(second.reEncrypted).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(afterFirst);
  });

  it('changes nothing on a dry run', async () => {
    const { filePath, contents: before } = await writeFixture();

    const result = await reEncrypt.reEncryptFile(filePath, { ...localUpgradePass(), dryRun: true });
    expect(result.reEncrypted.sort()).toEqual(['API_KEY', 'DATABASE_URL']);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('leaves references from another scheme alone', async () => {
    await localEncrypt.ensureKey();
    const filePath = path.join(projectDir, '.env.other');
    const contents = 'TEAM_SECRET=varlock("teamvault:AQIDBA==")\n';
    fs.writeFileSync(filePath, contents);

    const result = await reEncryptFileWithDefaults(filePath);
    expect(result.reEncrypted).toEqual([]);
    expect(result.skipped).toContainEqual({ key: 'TEAM_SECRET', reason: 'unknown-scheme' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(contents);
  });

  it('routes values through whatever source and target it is given', async () => {
    // a pass with no relation to v1 or v2: it picks up identity-encrypted
    // values and writes them somewhere else entirely
    const { filePath } = await writeFixture();
    const seen: Array<string> = [];

    const result = await reEncrypt.reEncryptFile(filePath, {
      source: {
        matches: (reference) => readPayloadVersion(reference.payload) === IDENTITY_PAYLOAD_VERSION,
        decrypt: async (reference) => {
          const plaintext = await localEncrypt.decryptValue(reference.payload);
          seen.push(plaintext);
          return plaintext;
        },
      },
      target: { scheme: 'local', encrypt: async (plaintext) => `rewritten-${plaintext}` },
    });

    expect(result.reEncrypted).toEqual(['ALREADY']);
    expect(seen).toEqual(['already-v2']);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('ALREADY=varlock("local:rewritten-already-v2")');
    // the v1 values were not this pass's source, so they were left alone
    expect(payloadVersionOf(fs.readFileSync(filePath, 'utf-8'), 'API_KEY')).toBe(DEVICE_PAYLOAD_VERSION);
  });
});

describe('canReEncryptLocally', () => {
  it('allows re-encryption on the file backend', () => {
    expect(reEncrypt.canReEncryptLocally()).toEqual({ ok: true });
  });
});
