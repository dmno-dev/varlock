/**
 * Cross-platform local encryption for varlock.
 *
 * Provides a unified API for encrypting/decrypting secrets using the best
 * available backend on the current platform:
 *
 *   1. macOS Secure Enclave (Swift binary) — hardware-backed, Touch ID
 *   2. Windows TPM/Hello (Rust binary) — hardware-backed, Windows Hello (TODO)
 *   3. Linux TPM2 (Rust binary) — hardware-backed (TODO)
 *   4. File-based (pure JS) — universal fallback, no native binary needed
 */

import { execFileSync } from 'node:child_process';
import { resolveNativeBinary } from './binary-resolver';
import { DaemonClient } from './daemon-client';
import * as fileBackend from './file-backend';
import type { BackendInfo, BackendType, NativeStatusResult } from './types';

export type { BackendInfo, BackendType } from './types';

const DEFAULT_KEY_ID = 'varlock-default';

// ── Native binary one-shot commands ────────────────────────────────────

function runNativeBinary(args: Array<string>): string {
  const binaryPath = resolveNativeBinary();
  if (!binaryPath) {
    throw new Error('Native binary not found');
  }
  return execFileSync(binaryPath, args, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

function runNativeBinaryJson<T = Record<string, unknown>>(args: Array<string>): T {
  const output = runNativeBinary(args);
  const parsed = JSON.parse(output);
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed as T;
}

// ── Backend detection ──────────────────────────────────────────────────

let cachedBackendInfo: BackendInfo | undefined;

function detectBackendType(): BackendType {
  const binaryPath = resolveNativeBinary();
  if (!binaryPath) return 'file';

  switch (process.platform) {
    case 'darwin': return 'secure-enclave';
    case 'win32': return 'windows-tpm';
    case 'linux': return 'linux-tpm';
    default: return 'file';
  }
}

/** Get information about the active encryption backend. */
export function getBackendInfo(): BackendInfo {
  if (cachedBackendInfo) return cachedBackendInfo;

  const type = detectBackendType();
  const binaryPath = type !== 'file' ? resolveNativeBinary() : undefined;

  if (type !== 'file' && binaryPath) {
    // Query the native binary for its actual capabilities
    try {
      const status = runNativeBinaryJson<NativeStatusResult>(['status']);
      cachedBackendInfo = {
        type,
        platform: process.platform,
        hardwareBacked: status.hardwareBacked,
        biometricAvailable: status.biometricAvailable,
        binaryPath,
      };
    } catch {
      // Binary failed — fall back to reasonable defaults
      cachedBackendInfo = {
        type,
        platform: process.platform,
        hardwareBacked: type === 'secure-enclave',
        biometricAvailable: type === 'secure-enclave',
        binaryPath,
      };
    }
  } else {
    cachedBackendInfo = {
      type,
      platform: process.platform,
      hardwareBacked: false,
      biometricAvailable: false,
      binaryPath: undefined,
    };
  }

  return cachedBackendInfo;
}

// ── Daemon client (singleton for biometric-enabled backends) ───────────

let daemonClient: DaemonClient | undefined;

function getDaemonClient(): DaemonClient {
  daemonClient ||= new DaemonClient();
  return daemonClient;
}

// ── Key management ─────────────────────────────────────────────────────

/** Check if a key exists. */
export function keyExists(keyId: string = DEFAULT_KEY_ID): boolean {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    return fileBackend.keyExists(keyId);
  }
  const result = runNativeBinaryJson<{ exists: boolean }>(['key-exists', '--key-id', keyId]);
  return result.exists;
}

/** Generate a new encryption key. */
export async function generateKey(keyId: string = DEFAULT_KEY_ID): Promise<{ keyId: string; publicKey: string }> {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    return fileBackend.generateKey(keyId);
  }
  return runNativeBinaryJson<{ keyId: string; publicKey: string }>(['generate-key', '--key-id', keyId]);
}

/** Ensure a key exists, generating one if necessary. */
export async function ensureKey(keyId: string = DEFAULT_KEY_ID): Promise<void> {
  if (!keyExists(keyId)) {
    await generateKey(keyId);
  }
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────

/**
 * Encrypt a plaintext value.
 *
 * For hardware-backed backends, encryption uses the public key only (no biometric needed).
 * For file-based backend, uses the pure JS ECIES implementation.
 */
export async function encryptValue(plaintext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    return fileBackend.encryptValue(plaintext, keyId);
  }
  // Native binary encrypt (one-shot, no biometric needed for encrypt)
  const b64Input = Buffer.from(plaintext, 'utf-8').toString('base64');
  const result = runNativeBinaryJson<{ ciphertext: string }>(['encrypt', '--key-id', keyId, '--data', b64Input]);
  return result.ciphertext;
}

/**
 * Decrypt a ciphertext value.
 *
 * For biometric-enabled backends (macOS Secure Enclave, Windows Hello),
 * uses the daemon client for session caching (avoids repeated biometric prompts).
 * For file-based backend, uses the pure JS ECIES implementation.
 */
export async function decryptValue(ciphertext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    return fileBackend.decryptValue(ciphertext, keyId);
  }

  // Use daemon client for biometric backends (session caching)
  if (backend.biometricAvailable) {
    const client = getDaemonClient();
    return client.decrypt(ciphertext, keyId);
  }

  // Non-biometric native backend (e.g., Linux TPM without polkit) — one-shot
  const result = runNativeBinaryJson<{ plaintext: string }>(['decrypt', '--key-id', keyId, '--data', ciphertext]);
  return result.plaintext;
}

/**
 * Invalidate the biometric session, requiring re-authentication for next decrypt.
 * Connects to the running daemon without spawning one (varlock lock runs in a separate process).
 */
export async function lockSession(): Promise<void> {
  const backend = getBackendInfo();
  if (!backend.biometricAvailable) return;
  const client = getDaemonClient();
  const connected = await client.tryConnect();
  if (!connected) {
    throw new Error('No encryption daemon is running');
  }
  await client.invalidateSession();
}
