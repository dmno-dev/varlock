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

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolveNativeBinary, getInstalledPlatformPackageName } from './binary-resolver';
import { DEFAULT_KEY_ID } from './constants';
import { assertSupportedPayloadVersion, IDENTITY_PAYLOAD_VERSION, readPayloadVersion } from './crypto';
import { DaemonClient } from './daemon-client';
import * as fileBackend from './file-backend';
import * as identity from './identity';
import {
  clearKnownGrants, decryptIdentityPayloadsViaDaemon, type IdentityPayloadRequest,
} from './session-decrypt';
import { isWSL } from './wsl-detect';
import type {
  BackendInfo, BackendType, InvalidateSessionRequest, NativeKeyDetail, NativeStatusResult,
  SessionGrantInfo, UnlockDisplayInfo,
} from './types';

export type {
  BackendInfo, BackendType, NativeKeyDetail, SessionGrantInfo, UnlockDisplayInfo,
} from './types';

export { DEFAULT_KEY_ID };
export {
  IdentityBackendUnsupportedError, IdentityNotFoundError, IdentityWrapMissingError,
} from './identity';
export { UnlockDeclinedError, UnlockNoUiError } from './session-decrypt';
export { StaleDaemonError } from './daemon-client';

/** Debug logger — prints to stderr when VARLOCK_DEBUG is set */
function debug(msg: string) {
  if (process.env.VARLOCK_DEBUG) {
    process.stderr.write(`[varlock:local-encrypt] ${msg}\n`);
  }
}

/** The same debug logger, for the sibling modules that make up this layer */
export const debugLog = debug;

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
    // Passed explicitly rather than left to inherit. Under Bun, which is what
    // the compiled varlock binary runs on, a child with no `env` gets the env
    // this process *started* with, so anything set at runtime (XDG_CONFIG_HOME,
    // HOME) would be invisible to the helper and it would read a different key
    // store than the one this process is using. Node inherits the live env, so
    // being explicit is what makes the two agree.
    env: process.env,
  }).trim();
  debug(`runNativeBinary result: ${opts?.sensitiveOutput ? `<${output.length} chars>` : output.slice(0, 200)}`);
  return output;
}

/**
 * Spawn the native binary asynchronously, writing `input` to its stdin and
 * resolving with its stdout.
 *
 * Async rather than `spawnSync` because this runs on the cache write path,
 * inside the cache key lock. A blocking spawn there stalls every other
 * concurrent item resolution in the process, and would freeze the lock's
 * liveness heartbeat so a busy holder looks dead to other processes.
 */
function spawnNativeBinaryAsync(
  binaryPath: string,
  args: Array<string>,
  opts: { input: string; timeout?: number },
): Promise<string> {
  const timeoutMs = opts.timeout ?? 30_000;
  return new Promise((resolve, reject) => {
    debug(`spawnNativeBinaryAsync: ${binaryPath} ${redactDataArg(args).join(' ')}`);
    // env passed explicitly for the same reason as in runNativeBinary above
    const proc = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // held in an object so `finish` can clear a timer declared after it
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};

    const finish = (err?: Error, out?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(pending.timer);
      if (err) reject(err);
      else resolve(out ?? '');
    };

    pending.timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new Error(`Native binary timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      // the binary reports failures as JSON on stdout, so a non-zero exit with
      // output is still handed back for the caller to parse
      if (!stdout.trim()) {
        finish(new Error(`Native binary exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      finish(undefined, stdout);
    });
    proc.stdin.on('error', () => {
      // the child can exit before we finish writing, EPIPE here is not useful
      debug('spawnNativeBinaryAsync: stdin write failed (child already exited)');
    });
    proc.stdin.end(opts.input);
  });
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
/** Per-key metadata reported by the status command (binaries that predate it omit it) */
let cachedKeyDetails: Array<NativeKeyDetail> | undefined;

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
      // keyDetails decides whether a decrypt goes through the daemon at all, so
      // a helper that does not report it is worth seeing in a debug log
      debug(`getBackendInfo: keyDetails=${status.keyDetails
        ? status.keyDetails.map((d) => `${d.keyId}:requireAuth=${d.requireAuth}`).join(',')
        : '<not reported by this helper>'}`);
      cachedStatusKeys = status.keys;
      cachedKeyDetails = status.keyDetails;
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
  // Name the optional dependency only for package-manager installs. Standalone
  // and development layouts deliver the helper through other paths.
  const expectedPkg = getInstalledPlatformPackageName();
  const expectedNote = expectedPkg
    ? ` (native helper normally arrives via the "${expectedPkg}" optional dependency; installs with --no-optional / --omit=optional skip it)`
    : '';
  process.stderr.write(
    `[varlock] Warning: native encryption binary not found, falling back to file-based encryption (not hardware-backed)${expectedNote}\n`,
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

/**
 * Whether decrypts of this key should require user-presence verification
 * (on machines that have a gate at all).
 *
 * Three cases, and all three are pinned by tests:
 *
 *   - the binary reports no `keyDetails` at all (an older native helper): true,
 *     because prompting when we did not need to is the safe way to be wrong
 *   - the key was created with `--no-auth` (CI and headless hosts): false, so it
 *     takes the one-shot non-interactive path with no daemon and no session
 *   - anything else, including `--auth-every-time` keys: true
 *
 * The `--no-auth` case is the one that changed: those keys used to be routed
 * through the daemon like every other key, because no binary reported the flag.
 */
export function keyRequiresAuth(keyId: string): boolean {
  // the per-key metadata arrives with the backend probe, so make sure that has
  // happened: without this the answer depends on whether something else ran first
  getBackendInfo();
  const detail = cachedKeyDetails?.find((d) => d.keyId === keyId);
  return detail?.requireAuth ?? true;
}

/** Generate a new encryption key. */
export async function generateKey(keyId: string = DEFAULT_KEY_ID): Promise<{ keyId: string; publicKey: string }> {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    warnIfFileFallback(backend);
    return fileBackend.generateKey(keyId);
  }
  const result = runNativeBinaryJson<{ keyId: string; publicKey: string }>(['generate-key', '--key-id', keyId]);
  // keep the status-derived caches coherent so lookups later in this same
  // process (keyExists, decrypt routing) see the new key
  cachedStatusKeys?.push(keyId);
  cachedKeyDetails?.push({ keyId, requireAuth: true });
  return result;
}

/** Ensure a key exists, generating one if necessary. */
export async function ensureKey(keyId: string = DEFAULT_KEY_ID): Promise<void> {
  if (!keyExists(keyId)) {
    await generateKey(keyId);
  }
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────

/**
 * Encrypt directly to the device key, producing a v1 payload.
 *
 * For hardware-backed backends, encryption uses the public key only (no biometric needed).
 * For file-based backend, uses the pure JS ECIES implementation.
 */
async function encryptToDeviceKey(plaintext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
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

  const stdout = await spawnNativeBinaryAsync(binaryPath, ['encrypt', '--key-id', keyId, '--data-stdin'], {
    input: b64Input,
    timeout: 30_000,
  });
  const result = JSON.parse(stdout.trim());
  if (result.error) throw new Error(result.error);
  return result.ciphertext;
}

/**
 * Decrypt a v1 (device-direct) ciphertext value.
 *
 * For biometric-enabled backends (macOS Secure Enclave, Windows Hello),
 * uses the daemon client for session caching (avoids repeated biometric prompts).
 * For file-based backend, uses the pure JS ECIES implementation.
 */
async function decryptWithDeviceKey(ciphertext: string, keyId: string = DEFAULT_KEY_ID): Promise<string> {
  const backend = getBackendInfo();
  if (backend.type === 'file') {
    debug('decryptValue: using file backend');
    warnIfFileFallback(backend);
    return fileBackend.decryptValue(ciphertext, keyId);
  }

  // Use daemon client for biometric backends (session caching).
  // A key whose metadata opts out of the presence gate takes the one-shot path
  // below instead. No binary reports that today, so every key gates as before.
  // In WSL2, the .exe handles daemon management internally via --via-daemon
  if (backend.biometricAvailable && keyRequiresAuth(keyId)) {
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

  // One-shot decrypt: non-biometric native backend (e.g. Linux TPM without
  // polkit), or a key that opted out of the presence gate
  debug('decryptValue: non-biometric one-shot decrypt');
  const result = runNativeBinaryJson<{ plaintext: string }>(
    ['decrypt', '--key-id', keyId, '--data', ciphertext],
    { sensitiveOutput: true },
  );
  return result.plaintext;
}

// ── Identity routing ───────────────────────────────────────────────────

/**
 * Device-key crypto handed to the identity layer, which uses it to wrap and
 * unwrap the identity private key. Always v1, never identity-routed: the wrap
 * is what makes identity payloads readable in the first place.
 */
const deviceCrypto: identity.DeviceCrypto = {
  encrypt: (plaintext, keyId) => encryptToDeviceKey(plaintext, keyId),
  decrypt: (ciphertext, keyId) => decryptWithDeviceKey(ciphertext, keyId),
};

/**
 * Whether this process is allowed to unwrap the identity private key itself.
 *
 * True only on the file backend, where the device key guarding the wrap is a
 * plaintext file anyway, so routing through a daemon would protect nothing. On
 * every hardware backend the daemon does the unwrapping and the key never
 * reaches V8.
 */
function mayUnwrapIdentityInProcess(): boolean {
  return getBackendInfo().type === 'file';
}

function identityOpts() {
  return { allowInProcessUnwrap: mayUnwrapIdentityInProcess() };
}

/**
 * Whether v2 payloads can be opened at all here.
 *
 * WSL is the one place they cannot. It reaches the Windows daemon by running the
 * helper .exe once per call, and each of those runs is its own session, so there
 * is no session for a grant to belong to. Writes there stay on v1 so a WSL
 * machine never produces a value it cannot read back.
 */
export function canUseIdentityEncryption(): boolean {
  return !isWSL();
}

/**
 * Whether new values should be encrypted to the identity key (v2) rather than
 * straight to the device key (v1).
 *
 * Every backend that can read a v2 payload also writes them. Encryption itself
 * is public-key only, so it needs no daemon, no grant and no presence check on
 * any backend: what decides this is purely whether reading back would work.
 */
function shouldEncryptToIdentity(): boolean {
  return canUseIdentityEncryption();
}

/**
 * Make sure everything needed to encrypt is in place: the device key, plus the
 * identity when this backend encrypts to one.
 */
export async function ensureEncryptionReady(keyId: string = DEFAULT_KEY_ID): Promise<void> {
  await ensureKey(keyId);
  if (shouldEncryptToIdentity()) {
    await identity.ensureIdentity(deviceCrypto, keyId, undefined, identityOpts());
  }
}

/**
 * The public key new values are encrypted to, creating the identity if this is
 * its first use. Undefined when this machine writes v1 payloads.
 *
 * Callers that hand encryption to the daemon (the secure input dialog) need the
 * recipient without doing the encrypting themselves.
 */
export async function getEncryptionIdentityPublicKey(
  keyId: string = DEFAULT_KEY_ID,
): Promise<string | undefined> {
  if (!shouldEncryptToIdentity()) return undefined;
  const stored = await identity.ensureIdentity(deviceCrypto, keyId, undefined, identityOpts());
  return stored.publicKey;
}

/**
 * Encrypt a plaintext value.
 *
 * Routes to the identity key where that backend supports it, and to the device
 * key otherwise. Pass `target: 'device'` to force a v1 payload.
 */
export async function encryptValue(
  plaintext: string,
  keyId: string = DEFAULT_KEY_ID,
  opts?: { target?: 'auto' | 'device' },
): Promise<string> {
  if (opts?.target !== 'device' && shouldEncryptToIdentity()) {
    debug('encryptValue: encrypting to identity key (v2)');
    return identity.encryptToIdentity(deviceCrypto, plaintext, keyId, undefined, identityOpts());
  }
  return encryptToDeviceKey(plaintext, keyId);
}

/**
 * Open identity-encrypted (v2) payloads as one group.
 *
 * This is the batched entry point, and the one callers resolving a whole env
 * file should reach for: on a hardware backend the whole group costs a single
 * unlock, where the same payloads opened one at a time could cost one each.
 * Results come back in the order they were passed in.
 */
export async function decryptIdentityPayloads(
  payloads: Array<IdentityPayloadRequest>,
  opts?: { display?: UnlockDisplayInfo },
): Promise<Array<string>> {
  if (payloads.length === 0) return [];
  for (const payload of payloads) assertSupportedPayloadVersion(payload.ciphertext);

  const backend = getBackendInfo();

  if (backend.type === 'file') {
    debug(`decryptIdentityPayloads: ${payloads.length} payload(s) via the file backend`);
    warnIfFileFallback(backend);
    const plaintexts: Array<string> = [];
    for (const payload of payloads) {
      plaintexts.push(await identity.decryptWithIdentity(deviceCrypto, payload.ciphertext));
    }
    return plaintexts;
  }

  if (!canUseIdentityEncryption()) {
    throw new identity.IdentityBackendUnsupportedError(backend.type);
  }

  debug(`decryptIdentityPayloads: ${payloads.length} payload(s) via the daemon session`);
  return decryptIdentityPayloadsViaDaemon(getDaemonClient(), payloads, opts);
}

/**
 * Decrypt a ciphertext value, routing on the payload version byte.
 *
 * v1 payloads go to the device key exactly as they always have. v2 payloads go
 * through the identity: in-process on the file backend, and through the daemon's
 * unlock session everywhere else. Decrypting a single value is just a batch of
 * one, so callers with several should use `decryptIdentityPayloads` instead and
 * pay for one unlock rather than one per value.
 *
 * `display` is what the unlock panel says this decrypt is for. Pass it: a
 * caller that does not is a caller the panel has to describe as "something",
 * and a person cannot approve something the panel cannot name.
 */
export async function decryptValue(
  ciphertext: string,
  keyId: string = DEFAULT_KEY_ID,
  opts?: { display?: UnlockDisplayInfo },
): Promise<string> {
  // checked here rather than per-backend so payloads from a newer varlock fail
  // the same way everywhere, including on the native binary paths
  assertSupportedPayloadVersion(ciphertext);

  if (readPayloadVersion(ciphertext) === IDENTITY_PAYLOAD_VERSION) {
    debug('decryptValue: identity-encrypted payload (v2)');
    const [plaintext] = await decryptIdentityPayloads([{ ciphertext, keyId }], opts);
    return plaintext;
  }

  return decryptWithDeviceKey(ciphertext, keyId);
}

/**
 * Invalidate unlock sessions, so the next decrypt has to ask again.
 *
 * With no target this drops everything the daemon is holding, as it always has.
 * `sessionId` drops one session's grants; the caller's own session is named by
 * passing no id and letting the daemon resolve it from the connection, which is
 * what `varlock lock --current` does.
 *
 * Connects to a running daemon without spawning one: locking a daemon that is
 * not there is already the state the user asked for.
 */
export async function lockSession(target?: InvalidateSessionRequest): Promise<number> {
  // an unwrapped identity key held in this process outlives a daemon lock, so
  // drop it too, along with the grants this process thought it had
  identity.clearUnwrappedIdentityCache();
  clearKnownGrants();

  const backend = getBackendInfo();
  if (!backend.biometricAvailable) return 0;
  const client = getDaemonClient();
  const connected = await client.tryConnect();
  if (!connected) {
    throw new Error('No encryption daemon is running');
  }
  const result = await client.invalidateSession(target);
  return result.invalidated;
}

/**
 * The session id the daemon resolves for this process.
 *
 * Derived by the daemon from the connection, never claimed by us, so it is the
 * one way to name "my own session" without being able to name anyone else's.
 * Undefined when no daemon is running or it could not place this caller.
 */
export async function getCurrentSessionId(): Promise<string | undefined> {
  const backend = getBackendInfo();
  if (!backend.biometricAvailable) return undefined;
  const client = getDaemonClient();
  const connected = await client.tryConnect();
  if (!connected) return undefined;
  return (await client.ping()).sessionId;
}

/**
 * Every unlock session the daemon is currently holding.
 *
 * Connects without spawning: a daemon that is not running holds nothing, which
 * is an empty list rather than an error.
 */
export async function listSessions(): Promise<Array<SessionGrantInfo>> {
  const backend = getBackendInfo();
  if (!backend.biometricAvailable) return [];
  const client = getDaemonClient();
  const connected = await client.tryConnect();
  if (!connected) return [];
  const result = await client.listSessions();
  return result.sessions;
}
