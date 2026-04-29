import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  keyExists, generateKey, deleteKey, listKeys, encryptValue, decryptValue,
} from './file-backend';

// Use a temp directory for all key operations during tests
const testDir = path.join(os.tmpdir(), `varlock-test-${process.pid}`);

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

beforeEach(() => {
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('file-backend', () => {
  it('generates and checks key existence', async () => {
    expect(keyExists('test-key')).toBe(false);
    const result = await generateKey('test-key');
    expect(result.keyId).toBe('test-key');
    expect(result.publicKey).toBeTruthy();
    expect(keyExists('test-key')).toBe(true);
  });

  it('uses default key id', async () => {
    await generateKey();
    expect(keyExists()).toBe(true);
    expect(keyExists('varlock-default')).toBe(true);
  });

  it('lists keys', async () => {
    expect(listKeys()).toEqual([]);
    await generateKey('key-a');
    await generateKey('key-b');
    const keys = listKeys();
    expect(keys).toContain('key-a');
    expect(keys).toContain('key-b');
    expect(keys).toHaveLength(2);
  });

  it('deletes keys', async () => {
    await generateKey('to-delete');
    expect(keyExists('to-delete')).toBe(true);
    expect(deleteKey('to-delete')).toBe(true);
    expect(keyExists('to-delete')).toBe(false);
    expect(deleteKey('nonexistent')).toBe(false);
  });

  it('round-trips encrypt → decrypt', async () => {
    await generateKey('round-trip');
    const plaintext = 'super secret value!';
    const ciphertext = await encryptValue(plaintext, 'round-trip');
    const decrypted = await decryptValue(ciphertext, 'round-trip');
    expect(decrypted).toBe(plaintext);
  });

  it('fails to encrypt with nonexistent key', async () => {
    await expect(encryptValue('test', 'nonexistent')).rejects.toThrow('Key not found');
  });

  it('fails to decrypt with nonexistent key', async () => {
    await expect(decryptValue('dGVzdA==', 'nonexistent')).rejects.toThrow('Key not found');
  });

  it('fails to decrypt with wrong key', async () => {
    await generateKey('key-1');
    await generateKey('key-2');
    const ciphertext = await encryptValue('secret', 'key-1');
    await expect(decryptValue(ciphertext, 'key-2')).rejects.toThrow();
  });
});
