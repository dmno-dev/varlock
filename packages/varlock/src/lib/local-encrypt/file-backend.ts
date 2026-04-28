/**
 * File-based local encryption backend.
 *
 * Stores P-256 ECDH key pairs as JSON files on disk with restricted permissions.
 * Uses the pure JS ECIES implementation for all crypto operations.
 * Works on all platforms — no native binary required.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getUserVarlockDir } from '../user-config-dir';
import { createKeyPair, encrypt, decrypt } from './crypto';

const KEY_STORE_SUBDIR = 'local-encrypt/keys';
const DEFAULT_KEY_ID = 'varlock-default';

interface StoredKeyPair {
  keyId: string;
  publicKey: string;
  privateKey: string;
  protectedPrivateKey?: string;
  protection?: 'none' | string;
  createdAt: string;
}

function getKeyStorePath(): string {
  return path.join(getUserVarlockDir(), KEY_STORE_SUBDIR);
}

function getKeyFilePath(keyId: string): string {
  return path.join(getKeyStorePath(), `${keyId}.json`);
}

// ── Key management ─────────────────────────────────────────────────────

export function keyExists(keyId: string = DEFAULT_KEY_ID): boolean {
  return fs.existsSync(getKeyFilePath(keyId));
}

export async function generateKey(keyId: string = DEFAULT_KEY_ID): Promise<{ keyId: string; publicKey: string }> {
  const keyPair = await createKeyPair();

  const stored: StoredKeyPair = {
    keyId,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    createdAt: new Date().toISOString(),
  };

  const keyStorePath = getKeyStorePath();
  fs.mkdirSync(keyStorePath, { recursive: true });

  const filePath = getKeyFilePath(keyId);
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 });

  return { keyId, publicKey: keyPair.publicKey };
}

export function deleteKey(keyId: string = DEFAULT_KEY_ID): boolean {
  const filePath = getKeyFilePath(keyId);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function listKeys(): Array<string> {
  const keyStorePath = getKeyStorePath();
  try {
    return fs.readdirSync(keyStorePath)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ── Internal key loading ───────────────────────────────────────────────

function loadKeyPair(keyId: string): StoredKeyPair {
  const filePath = getKeyFilePath(keyId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Key not found: ${keyId}`);
  }
  const data = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(data) as Partial<StoredKeyPair>;

  // Back-compat: older key files store private material under
  // `protectedPrivateKey` with `protection: "none"`.
  const privateKey = parsed.privateKey
    ?? (parsed.protection === 'none' ? parsed.protectedPrivateKey : undefined)
    ?? parsed.protectedPrivateKey;

  if (!parsed.publicKey || !privateKey) {
    throw new Error(`Invalid key file format for key: ${keyId}`);
  }

  return {
    keyId: parsed.keyId || keyId,
    publicKey: parsed.publicKey,
    privateKey,
    createdAt: parsed.createdAt || new Date().toISOString(),
    protection: parsed.protection,
    protectedPrivateKey: parsed.protectedPrivateKey,
  };
}

function getPublicKey(keyId: string): string {
  return loadKeyPair(keyId).publicKey;
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────

export async function encryptValue(plaintext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
  const publicKey = getPublicKey(keyId);
  return encrypt(publicKey, plaintext);
}

export async function decryptValue(ciphertext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
  const stored = loadKeyPair(keyId);
  return decrypt(stored.privateKey, stored.publicKey, ciphertext);
}
