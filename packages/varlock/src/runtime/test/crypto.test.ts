import { describe, it, expect } from 'vitest';
import {
  encryptEnvBlobSync,
  decryptEnvBlobSync,
  decryptEnvBlobAsync,
  isEncryptedBlob,
  generateEncryptionKeyHex,
} from '../crypto';

const TEST_KEY = 'a'.repeat(64); // valid 256-bit hex key
const TEST_JSON = JSON.stringify({
  config: { API_KEY: { value: 'secret-123', isSensitive: true } },
  sources: [],
  settings: {},
});

describe('crypto', () => {
  describe('isEncryptedBlob', () => {
    it('returns true for varlock:v1: prefixed strings', () => {
      expect(isEncryptedBlob('varlock:v1:abc')).toBe(true);
    });
    it('returns false for plain JSON', () => {
      expect(isEncryptedBlob('{"config":{}}')).toBe(false);
    });
  });

  describe('generateEncryptionKeyHex', () => {
    it('generates a 64-character hex string', () => {
      const key = generateEncryptionKeyHex();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
    it('generates unique keys', () => {
      const a = generateEncryptionKeyHex();
      const b = generateEncryptionKeyHex();
      expect(a).not.toBe(b);
    });
  });

  describe('sync encrypt/decrypt', () => {
    it('round-trips correctly', () => {
      const encrypted = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      expect(isEncryptedBlob(encrypted)).toBe(true);
      const decrypted = decryptEnvBlobSync(encrypted, TEST_KEY);
      expect(decrypted).toBe(TEST_JSON);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const a = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      const b = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      expect(a).not.toBe(b);
    });

    it('rejects invalid key length', () => {
      expect(() => encryptEnvBlobSync(TEST_JSON, 'tooshort')).toThrow('64-character hex string');
    });

    it('rejects wrong key on decrypt', () => {
      const encrypted = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      const wrongKey = 'b'.repeat(64);
      expect(() => decryptEnvBlobSync(encrypted, wrongKey)).toThrow();
    });

    it('rejects non-encrypted input on decrypt', () => {
      expect(() => decryptEnvBlobSync('plain text', TEST_KEY)).toThrow('varlock:v1: prefix');
    });
  });

  describe('async decrypt (Web Crypto)', () => {
    it('decrypts what sync encrypted', async () => {
      const encrypted = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      const decrypted = await decryptEnvBlobAsync(encrypted, TEST_KEY);
      expect(decrypted).toBe(TEST_JSON);
    });

    it('rejects wrong key', async () => {
      const encrypted = encryptEnvBlobSync(TEST_JSON, TEST_KEY);
      const wrongKey = 'b'.repeat(64);
      await expect(decryptEnvBlobAsync(encrypted, wrongKey)).rejects.toThrow();
    });
  });
});
