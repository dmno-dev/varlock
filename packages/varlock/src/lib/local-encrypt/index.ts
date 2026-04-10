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

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolveNativeBinary } from './binary-resolver';
import { DaemonClient } from './daemon-client';
import * as fileBackend from './file-backend';
import { isWSL } from './wsl-detect';
import type { BackendInfo, BackendType, NativeStatusResult } from './types';

export type { BackendInfo, BackendType } from './types';

const DEFAULT_KEY_ID = 'varlock-default';

/** Debug logger — prints to stderr when VARLOCK_DEBUG is set */
function debug(msg: string) {
  if (process.env.VARLOCK_DEBUG) {
    process.stderr.write(`[varlock:local-encrypt] ${msg}\n`);
  }
}

/**
 * Get a TTY identifier for session scoping.
 * Reads the controlling terminal from /proc/self/fd/0 or falls back to PID.
 */
let _cachedTtyId: string | undefined;
function getSelfTtyId(): string {
  if (_cachedTtyId) return _cachedTtyId;
  try {
    const ttyPath = fs.readlinkSync('/proc/self/fd/0');
    if (ttyPath && ttyPath.startsWith('/dev/')) {
      _cachedTtyId = ttyPath;
      return ttyPath;
    }
  } catch {
    // Not available
  }
  _cachedTtyId = `pid:${process.pid}`;
  return _cachedTtyId;
}

// ── Native binary one-shot commands ────────────────────────────────────

function runNativeBinary(args: Array<string>, opts?: { timeout?: number }): string {
  const binaryPath = resolveNativeBinary();
  if (!binaryPath) {
    debug('runNativeBinary: no binary found');
    throw new Error('Native binary not found');
  }
  debug(`runNativeBinary: ${binaryPath} ${args.join(' ')}`);
  const output = execFileSync(binaryPath, args, {
    encoding: 'utf-8',
    timeout: opts?.timeout ?? 30_000,
  }).trim();
  debug(`runNativeBinary result: ${output.slice(0, 200)}`);
  return output;
}

function runNativeBinaryJson<T = Record<string, unknown>>(args: Array<string>, opts?: { timeout?: number }): T {
  const output = runNativeBinary(args, opts);
  const parsed = JSON.parse(output);
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed as T;
}

// ── Backend detection ──────────────────────────────────────────────────

let cachedBackendInfo: BackendInfo | undefined;
/** Keys reported by the status command — avoids a separate key-exists .exe spawn on WSL2 */
let cachedStatusKeys: Array<string> | undefined;

function detectBackendType(): { type: BackendType; isFileFallback: boolean } {
  const binaryPath = resolveNativeBinary();
  debug(`detectBackendType: binaryPath=${binaryPath ?? 'NOT FOUND'}, isWSL=${isWSL()}, platform=${process.platform}`);
  if (!binaryPath) {
    // All supported platforms (macOS, Windows, Linux, WSL2) should have a native binary
    const isFileFallback = ['darwin', 'win32', 'linux'].includes(process.platform);
    return { type: 'file', isFileFallback };
  }

  // WSL2 uses the Windows binary for DPAPI + Windows Hello
  if (isWSL()) return { type: 'windows-tpm', isFileFallback: false };

  switch (process.platform) {
    case 'darwin': return { type: 'secure-enclave', isFileFallback: false };
    case 'win32': return { type: 'windows-tpm', isFileFallback: false };
    case 'linux': return { type: 'linux-tpm', isFileFallback: false };
    default: return { type: 'file', isFileFallback: false };
  }
}

/** Get information about the active encryption backend. */
export function getBackendInfo(): BackendInfo {
  if (cachedBackendInfo) return cachedBackendInfo;

  const { type, isFileFallback } = detectBackendType();
  const binaryPath = type !== 'file' ? resolveNativeBinary() : undefined;

  if (type !== 'file' && binaryPath) {
    // Query the native binary for its actual capabilities
    try {
      const status = runNativeBinaryJson<NativeStatusResult>(['status']);
      debug(`getBackendInfo: status result: hardwareBacked=${status.hardwareBacked}, biometricAvailable=${status.biometricAvailable}, backend=${status.backend}, keys=${status.keys?.join(',')}`);
      cachedStatusKeys = status.keys;
      cachedBackendInfo = {
        type,
        platform: process.platform,
        hardwareBacked: status.hardwareBacked,
        biometricAvailable: status.biometricAvailable,
        binaryPath,
      };
    } catch (err) {
      // Binary failed — fall back to reasonable defaults
      debug(`getBackendInfo: status command failed: ${err instanceof Error ? err.message : err}`);
      cachedBackendInfo = {
        type,
        platform: process.platform,
        hardwareBacked: type === 'secure-enclave',
        biometricAvailable: type === 'secure-enclave',
        binaryPath,
      };
    }
  } else {
    debug(`getBackendInfo: using file backend (type=${type}, binaryPath=${binaryPath ?? 'none'}, isFileFallback=${isFileFallback})`);
    if (isFileFallback) {
      process.stderr.write(
        '[varlock] Warning: native encryption binary not found, falling back to file-based encryption (not hardware-backed)\n',
      );
    }
    cachedBackendInfo = {
      type,
      platform: process.platform,
      hardwareBacked: false,
      biometricAvailable: false,
      binaryPath: undefined,
      isFileFallback,
    };
  }

  debug(`getBackendInfo: final result: type=${cachedBackendInfo!.type}, biometric=${cachedBackendInfo!.biometricAvailable}, hwBacked=${cachedBackendInfo!.hardwareBacked}`);
  return cachedBackendInfo!;
}

// ── Daemon client (singleton for biometric-enabled backends) ───────────

let daemonClient: DaemonClient | undefined;

export function getDaemonClient(): DaemonClient {
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
  // Use cached keys from status command to avoid an extra .exe spawn (significant on WSL2)
  if (cachedStatusKeys) {
    debug(`keyExists: using cached status keys for ${keyId}`);
    return cachedStatusKeys.includes(keyId);
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
    debug('decryptValue: using file backend');
    return fileBackend.decryptValue(ciphertext, keyId);
  }

  // Use daemon client for biometric backends (session caching)
  // In WSL2, the .exe handles daemon management internally via --via-daemon
  if (backend.biometricAvailable) {
    if (isWSL()) {
      debug('decryptValue: WSL2 biometric decrypt via --via-daemon');
      const binaryPath = resolveNativeBinary();
      if (!binaryPath) throw new Error('Native binary not found');
      // Use spawnSync with stdin to avoid exposing ciphertext or session
      // identity in process listings (visible via tasklist/procfs).
      // Stdin JSON includes both the data and the TTY ID for session scoping.
      const stdinPayload = JSON.stringify({
        data: ciphertext,
        ttyId: getSelfTtyId(),
      });
      const proc = spawnSync(binaryPath, ['decrypt', '--key-id', keyId, '--data-stdin', '--via-daemon'], {
        input: stdinPayload,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      if (proc.error) throw proc.error;
      if (proc.status !== 0) {
        const output = (proc.stdout || proc.stderr || '').trim();
        try {
          const parsed = JSON.parse(output);
          if (parsed.error) throw new Error(parsed.error);
        } catch { /* not JSON */ }
        throw new Error(`Decrypt failed (exit ${proc.status}): ${output}`);
      }
      const result = JSON.parse(proc.stdout.trim());
      if (result.error) throw new Error(result.error);
      debug(`decryptValue: WSL2 result: ${proc.stdout.trim().slice(0, 100)}`);
      return result.plaintext;
    }
    debug('decryptValue: biometric decrypt via daemon client');
    const client = getDaemonClient();
    return client.decrypt(ciphertext, keyId);
  }

  // Non-biometric native backend (e.g., Linux TPM without polkit) — one-shot
  debug('decryptValue: non-biometric one-shot decrypt');
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
