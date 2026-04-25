/**
 * Encrypt/decrypt utilities for the varlock env blob.
 *
 * Uses AES-256-GCM with a 12-byte random IV.
 * Encrypted format: "varlock:v1:" + base64(iv[12] + ciphertext + authTag[16])
 *
 * Sync versions use Node.js `node:crypto` (build-time + init-server).
 * Async version uses Web Crypto API (init-edge, where node:crypto is unavailable).
 */

const ENCRYPTED_PREFIX = 'varlock:v1:';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH_HEX = 64; // 32 bytes = 64 hex chars

export function isEncryptedBlob(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

function validateHexKey(hexKey: string): void {
  if (hexKey.length !== KEY_LENGTH_HEX || !/^[0-9a-f]+$/i.test(hexKey)) {
    throw new Error(`[varlock] _VARLOCK_ENV_KEY must be a ${KEY_LENGTH_HEX}-character hex string (256 bits)`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// -- Sync (Node.js node:crypto) ------------------------------------------

export function encryptEnvBlobSync(json: string, hexKey: string): string {
  validateHexKey(hexKey);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto');
  const keyBytes = hexToBytes(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return ENCRYPTED_PREFIX + combined.toString('base64');
}

export function decryptEnvBlobSync(encrypted: string, hexKey: string): string {
  validateHexKey(hexKey);
  if (!isEncryptedBlob(encrypted)) {
    throw new Error('[varlock] expected encrypted blob with varlock:v1: prefix');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto');
  const combined = Buffer.from(encrypted.slice(ENCRYPTED_PREFIX.length), 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', hexToBytes(hexKey), iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// -- Async (Web Crypto API, edge-compatible) ------------------------------
// Currently unused — all init paths use the sync version since every major edge
// runtime now supports node:crypto (Vercel Edge, Cloudflare with nodejs_compat, Deno).
// Kept as a public export in case consumers need to decrypt in a pure Web Crypto context.

export async function decryptEnvBlobAsync(encrypted: string, hexKey: string): Promise<string> {
  validateHexKey(hexKey);
  if (!isEncryptedBlob(encrypted)) {
    throw new Error('[varlock] expected encrypted blob with varlock:v1: prefix');
  }
  const raw = atob(encrypted.slice(ENCRYPTED_PREFIX.length));
  const combined = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) combined[i] = raw.charCodeAt(i);

  const iv = combined.slice(0, IV_LENGTH);
  // Web Crypto expects ciphertext + authTag concatenated (no separation needed)
  const ciphertextWithTag = combined.slice(IV_LENGTH);

  const keyBytes = hexToBytes(hexKey);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertextWithTag,
  );
  return new TextDecoder().decode(decrypted);
}

// -- Key generation -------------------------------------------------------

export function generateEncryptionKeyHex(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto');
  return (crypto.randomBytes(32) as Buffer).toString('hex');
}
