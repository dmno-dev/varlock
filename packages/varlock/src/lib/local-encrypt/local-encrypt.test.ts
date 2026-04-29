/**
 * Integration tests for the local-encrypt orchestration layer (index.ts).
 *
 * Forces the file-based fallback backend via _VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK
 * and exercises the full end-to-end flow: backend detection → key management → encrypt → decrypt.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Force file fallback BEFORE importing the module under test — the env var
// is checked at import time by the binary resolver's caching logic.
process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';

// Use a temp directory for key storage
const testDir = path.join(os.tmpdir(), `varlock-local-encrypt-test-${process.pid}`);

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

// Reset module-level caches between tests by re-importing fresh
let localEncrypt: typeof import('./index');

beforeEach(async () => {
  fs.mkdirSync(testDir, { recursive: true });
  // Reset the cached binary path and backend info by reimporting
  vi.resetModules();
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
  localEncrypt = await import('./index');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('local-encrypt with file fallback', () => {
  it('detects file backend when native binary is forced off', () => {
    const info = localEncrypt.getBackendInfo();
    expect(info.type).toBe('file');
    expect(info.hardwareBacked).toBe(false);
    expect(info.biometricAvailable).toBe(false);
    expect(info.binaryPath).toBeUndefined();
  });

  it('generates a key and reports it exists', async () => {
    expect(localEncrypt.keyExists('test-key')).toBe(false);
    await localEncrypt.generateKey('test-key');
    // Need to re-check after generation
    expect(localEncrypt.keyExists('test-key')).toBe(true);
  });

  it('ensureKey is idempotent', async () => {
    await localEncrypt.ensureKey('idem-key');
    expect(localEncrypt.keyExists('idem-key')).toBe(true);
    // calling again should not throw
    await localEncrypt.ensureKey('idem-key');
    expect(localEncrypt.keyExists('idem-key')).toBe(true);
  });

  it('round-trips encrypt → decrypt with default key', async () => {
    await localEncrypt.ensureKey();
    const plaintext = 'my-super-secret-api-key-12345';
    const ciphertext = await localEncrypt.encryptValue(plaintext);
    expect(ciphertext).toBeTruthy();
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = await localEncrypt.decryptValue(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips encrypt → decrypt with a named key', async () => {
    await localEncrypt.ensureKey('named-key');
    const plaintext = 'another secret value!';
    const ciphertext = await localEncrypt.encryptValue(plaintext, 'named-key');
    const decrypted = await localEncrypt.decryptValue(ciphertext, 'named-key');
    expect(decrypted).toBe(plaintext);
  });

  it('handles empty string', async () => {
    await localEncrypt.ensureKey();
    const ciphertext = await localEncrypt.encryptValue('');
    const decrypted = await localEncrypt.decryptValue(ciphertext);
    expect(decrypted).toBe('');
  });

  it('handles unicode and emoji', async () => {
    await localEncrypt.ensureKey();
    const plaintext = '🔐 sécret données — 日本語テスト';
    const ciphertext = await localEncrypt.encryptValue(plaintext);
    const decrypted = await localEncrypt.decryptValue(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('handles multi-line values', async () => {
    await localEncrypt.ensureKey();
    const plaintext = 'line1\nline2\nline3\n-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----';
    const ciphertext = await localEncrypt.encryptValue(plaintext);
    const decrypted = await localEncrypt.decryptValue(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong key', async () => {
    await localEncrypt.ensureKey('key-a');
    await localEncrypt.ensureKey('key-b');
    const ciphertext = await localEncrypt.encryptValue('secret', 'key-a');
    await expect(localEncrypt.decryptValue(ciphertext, 'key-b')).rejects.toThrow();
  });

  it('fails to decrypt garbage ciphertext', async () => {
    await localEncrypt.ensureKey();
    await expect(localEncrypt.decryptValue('not-valid-base64-ciphertext!')).rejects.toThrow();
  });

  it('fails to encrypt with nonexistent key', async () => {
    await expect(localEncrypt.encryptValue('test', 'no-such-key')).rejects.toThrow('Key not found');
  });

  it('produces different ciphertext each time (nonce is random)', async () => {
    await localEncrypt.ensureKey();
    const plaintext = 'same value';
    const ct1 = await localEncrypt.encryptValue(plaintext);
    const ct2 = await localEncrypt.encryptValue(plaintext);
    expect(ct1).not.toBe(ct2);
    // Both should decrypt to the same value
    expect(await localEncrypt.decryptValue(ct1)).toBe(plaintext);
    expect(await localEncrypt.decryptValue(ct2)).toBe(plaintext);
  });
});
