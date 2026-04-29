/**
 * Pure JS ECIES implementation using Node.js Web Crypto API.
 *
 * Wire-compatible with the Swift Secure Enclave implementation:
 *   - P-256 ECDH key agreement
 *   - HKDF-SHA256 (salt: "varlock-ecies-v1", info: ephemeralPub || recipientPub)
 *   - AES-256-GCM with random 12-byte nonce
 *   - Payload: version(1) | ephemeralPubKey(65) | nonce(12) | ciphertext(N) | tag(16)
 *
 * Adapted from PR #19's apple-crypto.ts, modified to match the custom ECIES scheme
 * used by the Swift SecureEnclaveManager rather than Apple's built-in variant.
 */

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

const PAYLOAD_VERSION = 0x01;
const HKDF_SALT = new TextEncoder().encode('varlock-ecies-v1');
const EC_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };

/** Uncompressed P-256 public key is 65 bytes (0x04 || x(32) || y(32)) */
const PUBLIC_KEY_LENGTH = 65;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + PUBLIC_KEY_LENGTH + NONCE_LENGTH; // version + pubkey + nonce

// Bun's types are stricter about BufferSource (requires ArrayBuffer, not ArrayBufferLike).
// This type assertion is safe — we always work with standard ArrayBuffers.

const bs = (data: Uint8Array | ArrayBuffer) => data as any;

// ── Key types ──────────────────────────────────────────────────────────

export interface EcKeyPair {
  /** Base64-encoded uncompressed P-256 public key (65 bytes raw) */
  publicKey: string;
  /** Base64-encoded PKCS8 private key */
  privateKey: string;
}

// ── Utilities ──────────────────────────────────────────────────────────

function concatBuffers(...buffers: Array<Uint8Array>): Uint8Array {
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  if (buffer instanceof Uint8Array) {
    return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('base64');
  }
  return Buffer.from(buffer).toString('base64');
}

function base64ToUint8(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ── HKDF-SHA256 ────────────────────────────────────────────────────────

/**
 * HKDF-SHA256 (RFC 5869) — matches the Swift SecureEnclaveManager.deriveKey implementation.
 *
 * We implement this manually rather than using Web Crypto's built-in HKDF because
 * the Web Crypto HKDF requires importing the input key material as a CryptoKey,
 * which adds complexity. This manual implementation is a direct port of the Swift code.
 */
async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  outputByteCount: number,
): Promise<Uint8Array> {
  // HKDF-Extract: PRK = HMAC-SHA256(salt, IKM)
  const saltKey = await subtle.importKey('raw', bs(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await subtle.sign('HMAC', saltKey, bs(ikm)));

  // HKDF-Expand: OKM = T(1) || T(2) || ...
  const prkKey = await subtle.importKey('raw', bs(prk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const okm = new Uint8Array(outputByteCount);
  let t = new Uint8Array(0);
  let offset = 0;
  let counter = 1;

  while (offset < outputByteCount) {
    const input = concatBuffers(t, info, new Uint8Array([counter]));
    t = new Uint8Array(await subtle.sign('HMAC', prkKey, bs(input)));
    okm.set(t.slice(0, Math.min(t.length, outputByteCount - offset)), offset);
    offset += t.length;
    counter++;
  }

  return okm;
}

// ── Key management ─────────────────────────────────────────────────────

/** Import a public key from its base64-encoded uncompressed representation. */
async function importPublicKey(base64: string): Promise<CryptoKey> {
  return subtle.importKey('raw', bs(base64ToUint8(base64)), EC_ALGORITHM, true, []);
}

/** Import a private key from its base64-encoded PKCS8 representation. */
async function importPrivateKey(base64: string): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', bs(base64ToUint8(base64)), EC_ALGORITHM, true, ['deriveBits']);
}

/** Generate a new P-256 ECDH key pair. */
export async function createKeyPair(): Promise<EcKeyPair> {
  const keyPair = await subtle.generateKey(EC_ALGORITHM, true, ['deriveBits']);

  const publicKeyRaw = await subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyPkcs8 = await subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKey: bufferToBase64(publicKeyRaw),
    privateKey: bufferToBase64(privateKeyPkcs8),
  };
}

// ── ECIES encrypt ──────────────────────────────────────────────────────

/**
 * Encrypt plaintext using ECIES with the recipient's public key.
 *
 * @param publicKeyBase64 - Base64-encoded uncompressed P-256 public key (65 bytes raw)
 * @param plaintext - UTF-8 string to encrypt
 * @returns Base64-encoded ciphertext payload
 */
export async function encrypt(publicKeyBase64: string, plaintext: string): Promise<string> {
  const recipientPublicKey = await importPublicKey(publicKeyBase64);
  const recipientPubKeyRaw = base64ToUint8(publicKeyBase64);

  // Generate ephemeral key pair
  const ephemeralKeyPair = await subtle.generateKey(EC_ALGORITHM, true, ['deriveBits']);
  const ephemeralPubKeyRaw = new Uint8Array(await subtle.exportKey('raw', ephemeralKeyPair.publicKey));

  // ECDH: ephemeral private × recipient public → shared secret (32 bytes for P-256)
  const sharedSecretBits = await subtle.deriveBits(
    { name: 'ECDH', public: recipientPublicKey },
    ephemeralKeyPair.privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedSecretBits);

  // HKDF-SHA256 → AES-256 key
  const info = concatBuffers(ephemeralPubKeyRaw, recipientPubKeyRaw);
  const aesKey = await hkdfSha256(sharedSecret, HKDF_SALT, info, 32);

  // AES-256-GCM encrypt
  const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const cryptoKey = await subtle.importKey('raw', bs(aesKey), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce), tagLength: TAG_LENGTH * 8 }, cryptoKey, bs(plaintextBytes)),
  );

  // Web Crypto appends the tag to ciphertext — split them to match Swift format
  const ciphertext = encrypted.slice(0, encrypted.length - TAG_LENGTH);
  const tag = encrypted.slice(encrypted.length - TAG_LENGTH);

  // Assemble payload: version(1) | ephemeralPub(65) | nonce(12) | ciphertext(N) | tag(16)
  const payload = concatBuffers(
    new Uint8Array([PAYLOAD_VERSION]),
    ephemeralPubKeyRaw,
    nonce,
    ciphertext,
    tag,
  );

  return bufferToBase64(payload);
}

// ── ECIES decrypt ──────────────────────────────────────────────────────

/**
 * Decrypt ciphertext using ECIES with the recipient's private key.
 *
 * @param privateKeyBase64 - Base64-encoded PKCS8 private key
 * @param publicKeyBase64 - Base64-encoded uncompressed P-256 public key of the recipient
 * @param ciphertextBase64 - Base64-encoded ciphertext payload
 * @returns Decrypted UTF-8 string
 */
export async function decrypt(
  privateKeyBase64: string,
  publicKeyBase64: string,
  ciphertextBase64: string,
): Promise<string> {
  const payloadBytes = base64ToUint8(ciphertextBase64);

  if (payloadBytes.byteLength < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error('Payload too short');
  }

  // Parse payload
  const version = payloadBytes[0];
  if (version !== PAYLOAD_VERSION) {
    throw new Error(`Unsupported payload version: ${version}`);
  }

  const ephemeralPubKeyRaw = payloadBytes.slice(1, 1 + PUBLIC_KEY_LENGTH);
  const nonce = payloadBytes.slice(1 + PUBLIC_KEY_LENGTH, HEADER_LENGTH);
  const ciphertextAndTag = payloadBytes.slice(HEADER_LENGTH);

  if (ciphertextAndTag.length < TAG_LENGTH) {
    throw new Error('Payload too short for tag');
  }

  // Import keys
  const privateKey = await importPrivateKey(privateKeyBase64);
  const ephemeralPublicKey = await subtle.importKey('raw', bs(ephemeralPubKeyRaw), EC_ALGORITHM, true, []);

  // Recipient public key bytes for HKDF info
  const recipientPubKeyRaw = base64ToUint8(publicKeyBase64);

  // ECDH: recipient private × ephemeral public → shared secret
  const sharedSecretBits = await subtle.deriveBits(
    { name: 'ECDH', public: ephemeralPublicKey },
    privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedSecretBits);

  // HKDF-SHA256 → AES-256 key (must match encrypt side)
  const info = concatBuffers(ephemeralPubKeyRaw, recipientPubKeyRaw);
  const aesKey = await hkdfSha256(sharedSecret, HKDF_SALT, info, 32);

  // AES-256-GCM decrypt
  // Web Crypto expects ciphertext + tag concatenated
  const cryptoKey = await subtle.importKey('raw', bs(aesKey), 'AES-GCM', false, ['decrypt']);
  try {
    const decrypted = await subtle.decrypt(
      { name: 'AES-GCM', iv: bs(nonce), tagLength: TAG_LENGTH * 8 },
      cryptoKey,
      bs(ciphertextAndTag), // already ciphertext || tag
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    throw new Error(
      'Unable to decrypt value',
      { cause: err },
    );
  }
}
