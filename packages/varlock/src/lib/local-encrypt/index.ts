/**
 * Cross-platform local encryption for varlock.
 *
 * Provides a unified API for encrypting/decrypting secrets using the best
 * available backend on the current platform:
 *
 *   1. macOS Secure Enclave (Swift binary) — hardware-backed, Touch ID
 *   2. Windows NCrypt TPM + Hello (Rust binary) — TPM at-rest; Hello presence gate
 *   3. Linux TPM2 / Secret Service (Rust binary) — hardware-backed on TPM hosts; polkit/PAM presence
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

const SHELL_RUNNER_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh']);
const VARLOCK_LAUNCHER_NAMES = new Set(['varlock', 'varlock.exe', 'varlock.cmd']);
const PACKAGE_MANAGER_RUNNER_NAMES = new Set(['bun', 'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg']);
const NO_TTY_SESSION_ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
] as const;

function getProcessName(pid: number): string | undefined {
  try {
    const exePath = fs.readlinkSync(`/proc/${pid}/exe`);
    return exePath.split('/').pop()?.toLowerCase();
  } catch { /* ignore */ }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim().toLowerCase();
  } catch {
    return undefined;
  }
}

function getProcessArgs(pid: number): Array<string> {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function processCommandLineLaunchesVarlock(pid: number): boolean {
  return getProcessArgs(pid).some((arg) => {
    const name = arg.split('/').pop()?.toLowerCase();
    return Boolean(
      (name && VARLOCK_LAUNCHER_NAMES.has(name))
      || arg.includes('/node_modules/.bin/varlock')
      || arg.includes('/varlock/bin/cli.js')
      || arg.includes('/packages/varlock/bin/cli.js'),
    );
  });
}

function isEphemeralRunner(pid: number): boolean {
  const name = getProcessName(pid);
  if (!name) return false;
  if (SHELL_RUNNER_NAMES.has(name) || VARLOCK_LAUNCHER_NAMES.has(name)) return true;
  return PACKAGE_MANAGER_RUNNER_NAMES.has(name) && processCommandLineLaunchesVarlock(pid);
}

function selectScopePidFromChain(chain: Array<number>): number | undefined {
  if (chain.length < 2) return undefined;

  if (chain.length >= 4) {
    let scopePid = chain[chain.length - 3];
    if (isEphemeralRunner(scopePid)) {
      const fallback = chain[chain.length - 2];
      scopePid = isEphemeralRunner(fallback) ? chain[chain.length - 1] : fallback;
    }
    return scopePid;
  }

  return chain[chain.length - 1];
}

function getProcessStartTime(pid: number): number {
  try {
    const scopeStat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const scopeFields = scopeStat.split(') ');
    if (scopeFields.length >= 2) {
      return parseInt(scopeFields[1].split(' ')[19], 10) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function getNoTtySessionIdFromEnv(): string | undefined {
  for (const key of NO_TTY_SESSION_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return `env:${key}:${value}`;
  }
  return undefined;
}

function getParentSessionId(): string {
  try {
    const ttyPath = fs.readlinkSync('/proc/self/fd/0');
    if (ttyPath && ttyPath.startsWith('/dev/')) {
      return ttyPath;
    }
  } catch {
    // Not available
  }

  try {
    const chain: Array<number> = [process.pid];
    let current = process.pid;
    for (let i = 0; i < 64; i++) {
      const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf-8');
      const fields = stat.split(') ');
      if (fields.length < 2) break;
      const ppid = parseInt(fields[1].split(' ')[1], 10);
      if (!ppid || ppid <= 1) break;
      chain.push(ppid);
      current = ppid;
    }
    const scopePid = selectScopePidFromChain(chain);
    if (scopePid !== undefined) {
      const startTime = getProcessStartTime(scopePid);
      return `ptree:${scopePid}:${startTime}`;
    }
  } catch {
    // Not available
  }

  return `pid:${process.pid}`;
}

/**
 * Get a session identifier for biometric session scoping (WSL only).
 * Prefers the controlling terminal; falls back to a stable ancestor PID
 * found by walking the process tree (mirrors the macOS Swift daemon logic).
 */
let _cachedSessionId: string | undefined;
function getSelfSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId;

  const parentSessionId = getParentSessionId();
  const envSessionId = getNoTtySessionIdFromEnv();
  if (envSessionId) {
    _cachedSessionId = `${envSessionId}|${parentSessionId}`;
    return _cachedSessionId;
  }

  _cachedSessionId = parentSessionId;
  return _cachedSessionId;
}

let _wslDaemonPrestartAttempted = false;

function toWindowsPathFromWsl(pathInWsl: string): string | undefined {
  if (!isWSL()) return undefined;
  try {
    return execFileSync('wslpath', ['-w', pathInWsl], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  } catch (err) {
    debug(`toWindowsPathFromWsl failed: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

function tryPrestartWindowsDaemonFromWsl(binaryPath: string): boolean {
  if (_wslDaemonPrestartAttempted) {
    return true;
  }

  const windowsPath = toWindowsPathFromWsl(binaryPath);
  if (!windowsPath) {
    return false;
  }

  // Ask native PowerShell to seed the daemon in the interactive desktop
  // session. This returns quickly; the follow-up decrypt call has a longer
  // timeout and the helper's own daemon retry path to absorb startup latency.
  const escapedPath = windowsPath.replaceAll("'", "''");
  const psScript = `Start-Process -WindowStyle Hidden -FilePath '${escapedPath}' -ArgumentList 'start-daemon'`;
  const proc = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    psScript,
  ], {
    encoding: 'utf-8',
    timeout: 20_000,
  });

  if (proc.error) {
    debug(`tryPrestartWindowsDaemonFromWsl: powershell error: ${proc.error.message}`);
    return false;
  }
  if (proc.status !== 0) {
    debug(`tryPrestartWindowsDaemonFromWsl: powershell exit ${proc.status}: ${(proc.stderr || proc.stdout || '').trim()}`);
    return false;
  }

  debug('tryPrestartWindowsDaemonFromWsl: start-daemon invoked via PowerShell');
  _wslDaemonPrestartAttempted = true;
  return true;
}

function pingWindowsDaemonFromWsl(binaryPath: string, timeoutMs: number = 2_000): boolean {
  const proc = spawnSync(binaryPath, ['ping-daemon'], {
    encoding: 'utf-8',
    timeout: timeoutMs,
  });

  if (proc.error || proc.status !== 0) {
    return false;
  }

  try {
    const parsed = JSON.parse((proc.stdout || '').trim()) as { ready?: boolean };
    return parsed.ready === true;
  } catch {
    return false;
  }
}

function waitForWindowsDaemonFromWsl(binaryPath: string, timeoutMs: number = 12_000): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pingWindowsDaemonFromWsl(binaryPath)) {
      debug('waitForWindowsDaemonFromWsl: daemon is ready');
      return true;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }

  debug('waitForWindowsDaemonFromWsl: timed out waiting for daemon readiness');
  return false;
}

// ── Native binary one-shot commands ────────────────────────────────────

/** Hide the payload following --data so plaintext/ciphertext never lands in debug logs */
function redactDataArg(args: Array<string>): Array<string> {
  const out = [...args];
  const i = out.indexOf('--data');
  if (i >= 0 && i + 1 < out.length) out[i + 1] = '<redacted>';
  return out;
}

function runNativeBinary(args: Array<string>, opts?: { timeout?: number; sensitiveOutput?: boolean }): string {
  const binaryPath = resolveNativeBinary();
  if (!binaryPath) {
    debug('runNativeBinary: no binary found');
    throw new Error('Native binary not found');
  }
  debug(`runNativeBinary: ${binaryPath} ${redactDataArg(args).join(' ')}`);
  const output = execFileSync(binaryPath, args, {
    encoding: 'utf-8',
    timeout: opts?.timeout ?? 30_000,
  }).trim();
  debug(`runNativeBinary result: ${opts?.sensitiveOutput ? `<${output.length} chars>` : output.slice(0, 200)}`);
  return output;
}

function runNativeBinaryJson<T = Record<string, unknown>>(
  args: Array<string>,
  opts?: { timeout?: number; sensitiveOutput?: boolean },
): T {
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

// getBackendInfo() is called as a passive capability probe on every load (cache
// auto-policy), so the fallback warning only fires when crypto ops actually run
let warnedFileFallback = false;
function warnIfFileFallback(backend: BackendInfo) {
  if (warnedFileFallback || !backend.isFileFallback) return;
  if (process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK) return;
  warnedFileFallback = true;
  process.stderr.write(
    '[varlock] Warning: native encryption binary not found, falling back to file-based encryption (not hardware-backed)\n',
  );
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
    warnIfFileFallback(backend);
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
    warnIfFileFallback(backend);
    return fileBackend.encryptValue(plaintext, keyId);
  }
  // Native binary encrypt (one-shot, no biometric needed for encrypt).
  // Plaintext is passed via stdin so it never appears in process listings
  // (and on WSL2, to avoid arg mangling across the WSL/Windows boundary).
  const b64Input = Buffer.from(plaintext, 'utf-8').toString('base64');
  const binaryPath = resolveNativeBinary();
  if (!binaryPath) throw new Error('Native binary not found');

  const proc = spawnSync(binaryPath, ['encrypt', '--key-id', keyId, '--data-stdin'], {
    input: b64Input,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (proc.error) throw proc.error;
  const result = JSON.parse(proc.stdout.trim());
  if (result.error) throw new Error(result.error);
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
    warnIfFileFallback(backend);
    return fileBackend.decryptValue(ciphertext, keyId);
  }

  // Use daemon client for biometric backends (session caching)
  // In WSL2, the .exe handles daemon management internally via --via-daemon
  if (backend.biometricAvailable) {
    if (isWSL()) {
      debug('decryptValue: WSL2 biometric decrypt via --via-daemon');
      const binaryPath = resolveNativeBinary();
      if (!binaryPath) throw new Error('Native binary not found');
      const daemonAlreadyReady = pingWindowsDaemonFromWsl(binaryPath, 1_500);
      const daemonPrestarted = daemonAlreadyReady || tryPrestartWindowsDaemonFromWsl(binaryPath);
      if (!daemonAlreadyReady && daemonPrestarted) {
        waitForWindowsDaemonFromWsl(binaryPath);
      }
      // Use spawnSync with stdin to avoid exposing ciphertext or session
      // identity in process listings (visible via tasklist/procfs).
      // Stdin JSON includes both the data and the session ID for session scoping.
      const stdinPayload = JSON.stringify({
        data: ciphertext,
        ttyId: getSelfSessionId(),
      });
      const runViaDaemon = (timeout: number) => spawnSync(binaryPath, ['decrypt', '--key-id', keyId, '--data-stdin', '--via-daemon'], {
        input: stdinPayload,
        encoding: 'utf-8',
        timeout,
      });

      let proc = runViaDaemon(daemonPrestarted ? 120_000 : 60_000);

      const output = (proc.stdout || proc.stderr || '').trim();
      const timedOut = proc.error && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      const needsRetry = Boolean(proc.error) || proc.status !== 0;
      const likelyDaemonStartupIssue = timedOut
        || /daemon is not running|daemon did not become ready within timeout|schtasks|windows hello daemon/i.test(output);

      if (needsRetry && likelyDaemonStartupIssue) {
        debug(`decryptValue: via-daemon startup issue detected; attempting native start-daemon bridge. output=${output.slice(0, 180)}`);
        if (tryPrestartWindowsDaemonFromWsl(binaryPath)) {
          // Give the daemon a little more room on first auth after bridge start.
          proc = runViaDaemon(120_000);
        }
      }

      if (proc.error) throw proc.error;
      if (proc.status !== 0) {
        const finalOutput = (proc.stdout || proc.stderr || '').trim();
        try {
          const parsed = JSON.parse(finalOutput);
          if (parsed.error) throw new Error(parsed.error);
        } catch { /* not JSON */ }

        const windowsPath = toWindowsPathFromWsl(binaryPath);
        const setupHint = windowsPath
          ? `\nHint: In native Windows PowerShell run:\n  Start-Process -WindowStyle Hidden "${windowsPath}" start-daemon`
          : '';
        throw new Error(`Decrypt failed (exit ${proc.status}): ${finalOutput}${setupHint}`);
      }

      const result = JSON.parse(proc.stdout.trim());
      if (result.error) throw new Error(result.error);
      debug(`decryptValue: WSL2 decrypt ok (<${proc.stdout.trim().length} chars>)`);
      return result.plaintext;
    }
    debug('decryptValue: biometric decrypt via daemon client');
    const client = getDaemonClient();
    return client.decrypt(ciphertext, keyId);
  }

  // Non-biometric native backend (e.g., Linux TPM without polkit) — one-shot
  debug('decryptValue: non-biometric one-shot decrypt');
  const result = runNativeBinaryJson<{ plaintext: string }>(
    ['decrypt', '--key-id', keyId, '--data', ciphertext],
    { sensitiveOutput: true },
  );
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
