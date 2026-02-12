import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

/**
 * HKDF-Expand implementation (RFC 5869)
 * Expands a PRK (pseudo-random key) into output keying material
 */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const hashLen = 32; // SHA-256 output length
  const n = Math.ceil(length / hashLen);

  if (n > 255) {
    throw new Error('HKDF-Expand: output length too large');
  }

  // Convert to plain Uint8Array to avoid type issues
  const prkBytes = new Uint8Array(prk);

  const prkKey = await subtle.importKey(
    'raw',
    prkBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const output = new Uint8Array(length);
  let t = new Uint8Array(0);
  let pos = 0;

  for (let i = 1; i <= n; i++) {
    // T(i) = HMAC(PRK, T(i-1) | info | i)
    const data = new Uint8Array(t.length + info.length + 1);
    data.set(t, 0);
    data.set(info, t.length);
    data[data.length - 1] = i;

    const hmacResult = await subtle.sign('HMAC', prkKey, data);
    t = new Uint8Array(hmacResult);

    const toCopy = Math.min(t.length, length - pos);
    output.set(t.subarray(0, toCopy), pos);
    pos += toCopy;
  }

  return output;
}

/**
 * Derive 64-byte key from 16-byte encryption key using Bitwarden's key derivation
 * Returns both encryption key (32 bytes) and MAC key (32 bytes)
 *
 * Process:
 * 1. HMAC-SHA256 with key="bitwarden-accesstoken" and message=16-byte secret → 32 bytes
 * 2. HKDF-Expand with info="sm-access-token" → 64 bytes
 * 3. Split into enc_key (32 bytes) + mac_key (32 bytes)
 */
export async function deriveKeyFromAccessToken(
  encryptionKeyBase64: string,
): Promise<{ encKey: webcrypto.CryptoKey; macKey: webcrypto.CryptoKey }> {
  const encryptionKey = new Uint8Array(Buffer.from(encryptionKeyBase64, 'base64'));

  // Step 1: HMAC-SHA256 with key="bitwarden-accesstoken"
  const hmacKeyString = 'bitwarden-accesstoken';
  const hmacKeyBytes = new TextEncoder().encode(hmacKeyString);

  const hmacKey = await subtle.importKey(
    'raw',
    hmacKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const hmacResult = await subtle.sign('HMAC', hmacKey, encryptionKey);
  const prk = new Uint8Array(hmacResult); // This is our 32-byte PRK for HKDF

  // Step 2: HKDF-Expand to 64 bytes (manual implementation since Web Crypto does Extract+Expand)
  const info = new TextEncoder().encode('sm-access-token');
  const derivedBytes = await hkdfExpand(prk, info, 64);

  // Step 3: Split into encryption key (first 32 bytes) and MAC key (last 32 bytes)
  const encKeyBytes = derivedBytes.slice(0, 32);
  const macKeyBytes = derivedBytes.slice(32, 64);

  // Import the encryption key
  const encKey = await subtle.importKey(
    'raw',
    encKeyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );

  // Import the MAC key
  const macKey = await subtle.importKey(
    'raw',
    macKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return { encKey, macKey };
}

/**
 * Decrypt AES-256-CBC encrypted value with HMAC verification
 * Format: 2.<iv_base64>|<ciphertext_base64>|<mac_base64>
 */
export async function decryptAes256CbcHmac(
  encryptedValue: string,
  encKey: webcrypto.CryptoKey,
  macKey: webcrypto.CryptoKey,
): Promise<string> {
  const parts = encryptedValue.split('.');
  if (parts.length !== 2 || parts[0] !== '2') {
    throw new Error(`Invalid encryption format: ${encryptedValue}`);
  }

  const [ivBase64, ciphertextBase64, macBase64] = parts[1].split('|');

  const iv = new Uint8Array(Buffer.from(ivBase64, 'base64'));
  const ciphertext = new Uint8Array(Buffer.from(ciphertextBase64, 'base64'));
  const mac = new Uint8Array(Buffer.from(macBase64, 'base64'));

  // MAC is computed over IV + ciphertext (per Bitwarden source code)
  const dataToVerify = new Uint8Array(iv.length + ciphertext.length);
  dataToVerify.set(iv, 0);
  dataToVerify.set(ciphertext, iv.length);

  const isValid = await subtle.verify(
    'HMAC',
    macKey,
    mac,
    dataToVerify,
  );

  if (!isValid) {
    throw new Error('MAC verification failed - data may be corrupted or tampered with');
  }

  // Decrypt using AES-256-CBC
  const decrypted = await subtle.decrypt(
    {
      name: 'AES-CBC',
      iv,
    },
    encKey,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}
