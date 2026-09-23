/**
 * Daemon client for communicating with the native encryption helper binary.
 *
 * Handles daemon lifecycle (spawn, connect, reconnect) and IPC messaging
 * using the 4-byte LE length-prefixed JSON protocol.
 *
 * - macOS/Linux: Unix domain socket
 * - Windows: named pipe (TODO)
 *
 * Generalized from the secure-enclave plugin's EnclaveDaemonClient.
 *
 * Note: WSL2 cannot connect to the Windows named-pipe daemon from the Linux
 * side. All WSL2 code paths that need biometric operations must bypass this
 * client and invoke the Windows binary directly (e.g. via --via-daemon).
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { getUserVarlockDir } from '../user-config-dir';
import { resolveNativeBinary } from './binary-resolver';
import { isWSL } from './wsl-detect';
import type {
  KeychainFixAccessResult, KeychainItemMeta, KeychainItemRef, KeychainSetResult,
} from './types';

/** Timeout for daemon IPC messages that don't involve user interaction */
const SEND_TIMEOUT_MS = 30_000;
/**
 * Timeout for messages that may trigger biometric auth (Touch ID).
 * Must exceed the Swift-side biometric timeout (60s) so the TS client
 * doesn't kill the daemon while Touch ID is still waiting for the user.
 * Killing mid-biometric can leave the process stuck in kernel UE state.
 */
const BIOMETRIC_TIMEOUT_MS = 90_000;
/** Timeout for interactive messages (GUI dialogs for secret input, keychain picker) */
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
/** How long to wait for SIGTERM before escalating to SIGKILL */
const KILL_GRACE_MS = 2_000;
/** Timeout for a liveness probe against a daemon that may already be gone */
const PROBE_TIMEOUT_MS = 2_000;

export class DaemonError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'DaemonError';
  }
}

function debug(msg: string) {
  if (process.env.VARLOCK_DEBUG) {
    process.stderr.write(`[varlock:daemon-client] ${msg}\n`);
  }
}

/**
 * Kill a daemon process, escalating from SIGTERM to SIGKILL if it doesn't
 * die within KILL_GRACE_MS. Handles the case where the process is already dead.
 *
 * Returns true if the process is confirmed dead, false if it's stuck in an
 * unkillable state (e.g. macOS UE/uninterruptible Secure Enclave wait).
 * Callers should clean up state files and proceed regardless — a zombie
 * with no socket file is effectively dead.
 */
function killDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true; // already dead
  }

  // Poll briefly to see if SIGTERM was effective
  const start = Date.now();
  while (Date.now() - start < KILL_GRACE_MS) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // process exited
    }
    // Busy-wait in small increments (this is a rare recovery path)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  // Still alive — force kill
  debug(`daemon pid ${pid} didn't respond to SIGTERM, sending SIGKILL`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return true; // already dead
  }

  // Give SIGKILL a moment to take effect
  const killStart = Date.now();
  while (Date.now() - killStart < 500) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // process exited
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  // Process is unkillable (UE state — stuck in kernel, e.g. Secure Enclave).
  // It's harmless once we remove the socket/PID files; it will clear on reboot.
  debug(`daemon pid ${pid} is unkillable (likely in uninterruptible kernel wait) — proceeding anyway`);
  return false;
}

function getSocketDir(): string {
  return path.join(getUserVarlockDir(), 'local-encrypt');
}

function getSocketPath(): string {
  if (process.platform === 'win32') {
    // Windows named pipe — fixed name shared by all varlock processes
    return '\\\\.\\pipe\\varlock-local-encrypt';
  }
  return path.join(getSocketDir(), 'daemon.sock');
}

function getPidPath(): string {
  return path.join(getSocketDir(), 'daemon.pid');
}

function getDaemonInfoPath(): string {
  return path.join(getSocketDir(), 'daemon.info');
}

/** PID recorded in the daemon PID file, whether or not that process still exists */
function readRecordedDaemonPid(): number | undefined {
  try {
    const pid = parseInt(fs.readFileSync(getPidPath(), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the daemon's bookkeeping files (PID + info), ignoring errors.
 *
 * Deliberately never touches the socket or lock file: those belong to whichever
 * daemon currently holds the startup lock. Unlinking them from a client orphans
 * a live daemon (its socket vanishes while the process keeps running, menu bar
 * item and all) and lets a second daemon bind alongside it, which costs the user
 * a second biometric prompt. A starting daemon clears the stale socket itself,
 * under the lock, where doing so is safe.
 */
function cleanupDaemonFiles(): void {
  for (const file of [getPidPath(), getDaemonInfoPath()]) {
    try {
      fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
}

/**
 * Clear the bookkeeping files left by a daemon we just took down, but only
 * while they still describe that daemon. Several clients can decide to replace
 * the same outdated daemon at once, and the slowest of them must not wipe the
 * files its replacement has already written.
 */
function cleanupDaemonFilesFor(pid: number): void {
  const recorded = readRecordedDaemonPid();
  if (recorded !== undefined && recorded !== pid) {
    debug(`leaving daemon state files alone: they belong to pid ${recorded}, not ${pid}`);
    return;
  }
  cleanupDaemonFiles();
}

/** Read the PID recorded by the running daemon, if it points at a live process */
function readLiveDaemonPid(): number | undefined {
  const pid = readRecordedDaemonPid();
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return undefined;
  }
}

const binaryHashCache = new Map<string, string | undefined>();

/** SHA-256 of a binary's contents, cached per process (hashing takes well under 1ms) */
function hashBinary(binaryPath: string): string | undefined {
  if (!binaryHashCache.has(binaryPath)) {
    let hash: string | undefined;
    try {
      hash = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
    } catch {
      hash = undefined;
    }
    binaryHashCache.set(binaryPath, hash);
  }
  return binaryHashCache.get(binaryPath);
}

/**
 * Whether a running daemon should be replaced by the binary we would spawn.
 *
 * Identity is the binary's content hash, not its install path or version:
 * release builds are cached by source hash, so varlock versions that didn't
 * change the daemon ship byte-identical binaries, and each project's copy lives
 * at a different path. Comparing contents lets those share one daemon (and one
 * biometric session), while a genuinely different daemon build is swapped in
 * when you move between projects.
 *
 * A daemon that doesn't report a hash predates this check, so it is always
 * replaced. If we can't hash our own binary, we leave the running daemon alone.
 */
export function shouldReplaceDaemon(runningHash: string | undefined, ourHash: string | undefined): boolean {
  if (!ourHash) return false;
  return runningHash !== ourHash;
}

export class DaemonClient {
  private socket: net.Socket | null = null;
  private messageQueue = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private isConnected = false;
  private buffer = Buffer.alloc(0);
  private connectingPromise: Promise<void> | null = null;

  async ensureConnected(): Promise<void> {
    if (this.isConnected && this.socket) return;

    // Deduplicate concurrent ensureConnected calls — multiple varlock() items
    // may resolve concurrently and all call decrypt → ensureConnected
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  /**
   * Try to connect to an existing daemon without spawning a new one.
   * Returns true if connected, false if no daemon is running.
   */
  async tryConnect(): Promise<boolean> {
    if (this.isConnected && this.socket) return true;
    const socketPath = getSocketPath();
    try {
      await this.connectToSocket(socketPath);
      return true;
    } catch {
      return false;
    }
  }

  private async doConnect(): Promise<void> {
    const socketPath = getSocketPath();

    // Connect first. Staleness is decided by asking the daemon we reach, never
    // by inspecting state files up front: during a cold parallel start (an MCP
    // host launching a dozen stdio servers at once) those files describe a
    // daemon that is still coming up, and acting on them kills a healthy one.
    try {
      await this.connectToSocket(socketPath);
    } catch (err) {
      debug(`no daemon to connect to (${err instanceof Error ? err.message : err}), spawning`);
      await this.spawnAndConnect(socketPath);
      return;
    }

    const replacePid = await this.findReplaceableDaemonPid();
    if (replacePid === undefined) return;

    // Replace at most once per connect: if another varlock install swaps the
    // daemon again before we reconnect, we use whatever wins rather than fight.
    debug(`replacing daemon (pid ${replacePid}): it runs a different binary than ours`);
    this.cleanup(); // drop our connection to the outgoing daemon
    killDaemonProcess(replacePid);
    cleanupDaemonFilesFor(replacePid);
    await this.spawnAndConnect(socketPath);
  }

  /** Spawn a daemon (tolerating a lost spawn race) and connect to whichever one wins */
  private async spawnAndConnect(socketPath: string): Promise<void> {
    try {
      await this.spawnDaemon();
    } catch (err) {
      // Another process may have won the race to spawn the daemon.
      // Wait briefly for it to be ready, then try connecting.
      debug(`spawnDaemon failed: ${err instanceof Error ? err.message : err}`);
      await new Promise<void>((r) => {
        setTimeout(r, 1000);
      });
    }
    await this.connectToSocket(socketPath);
  }

  /**
   * PID of the connected daemon when it runs a different binary than the one we
   * would spawn, or undefined when it should be kept.
   */
  private async findReplaceableDaemonPid(): Promise<number | undefined> {
    const binaryPath = resolveNativeBinary();
    const ourHash = binaryPath ? hashBinary(binaryPath) : undefined;
    if (!ourHash) return undefined;

    let pong: { pid?: number; binaryHash?: string };
    try {
      pong = await this.sendMessage({ action: 'ping' });
    } catch (err) {
      // A daemon that won't answer a ping is handled by the retry path, where
      // an actual operation has failed and killing it is clearly warranted.
      debug(`ping failed while checking the daemon binary: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }

    if (!shouldReplaceDaemon(pong?.binaryHash, ourHash)) return undefined;
    return pong?.pid ?? readLiveDaemonPid();
  }

  async decrypt(ciphertext: string, keyId = 'varlock-default'): Promise<string> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      const result = await this.sendMessage({
        action: 'decrypt',
        payload: { ciphertext, keyId },
      }, BIOMETRIC_TIMEOUT_MS);
      if (typeof result === 'string') return result;
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String(result.error));
      }
      return String(result);
    });
  }

  async promptSecret(opts?: {
    itemKey?: string;
    message?: string;
    keyId?: string;
  }): Promise<string | undefined> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      try {
        const result = await this.sendMessage({
          action: 'prompt-secret',
          payload: {
            itemKey: opts?.itemKey,
            message: opts?.message,
            keyId: opts?.keyId,
          },
        }, INTERACTIVE_TIMEOUT_MS);
        if (result && typeof result === 'object' && 'ciphertext' in result) {
          return result.ciphertext as string;
        }
        return undefined;
      } catch (err) {
        if (err instanceof Error && err.message === 'cancelled') return undefined;
        throw err;
      }
    });
  }

  async invalidateSession(): Promise<void> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      await this.sendMessage({ action: 'invalidate-session' });
    });
  }

  async keychainGet(opts: { service?: string; account?: string; keychain?: string; field?: string }): Promise<string> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      // Password reads may trigger biometric; metadata field reads won't,
      // but we use the biometric timeout for both since it's harmless.
      const result = await this.sendMessage({
        action: 'keychain-get',
        payload: opts,
      }, BIOMETRIC_TIMEOUT_MS);
      if (typeof result === 'string') return result;
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String(result.error));
      }
      return String(result);
    });
  }

  async keychainSearch(opts?: { query?: string; keychain?: string }): Promise<Array<KeychainItemMeta>> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      const result = await this.sendMessage({
        action: 'keychain-search',
        payload: opts ?? {},
      });
      return (result ?? []) as Array<KeychainItemMeta>;
    });
  }

  async keychainPick(opts?: { itemKey?: string }): Promise<KeychainItemRef | undefined> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      try {
        const result = await this.sendMessage({
          action: 'keychain-pick',
          payload: { itemKey: opts?.itemKey },
        }, INTERACTIVE_TIMEOUT_MS);
        if (result && typeof result === 'object' && 'service' in result) {
          return result as KeychainItemRef;
        }
        return undefined;
      } catch (err) {
        if (err instanceof Error && err.message === 'cancelled') return undefined;
        throw err;
      }
    });
  }

  async keychainFixAccess(opts: {
    service: string;
    account?: string;
    keychain?: string;
  }): Promise<KeychainFixAccessResult> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      const result = await this.sendMessage({
        action: 'keychain-fix-access',
        payload: opts,
      }, INTERACTIVE_TIMEOUT_MS);
      return result as KeychainFixAccessResult;
    });
  }

  async keychainSet(opts: {
    service: string;
    account?: string;
    value: string;
    update?: boolean;
  }): Promise<KeychainSetResult> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      const result = await this.sendMessage({
        action: 'keychain-set',
        payload: opts,
      }, BIOMETRIC_TIMEOUT_MS);
      return result as KeychainSetResult;
    });
  }

  cleanup(): void {
    for (const { reject } of this.messageQueue.values()) {
      reject(new Error('Connection closed'));
    }
    this.messageQueue.clear();
    this.socket?.end();
    this.socket = null;
    this.isConnected = false;
    this.buffer = Buffer.alloc(0);
  }

  // -- Private --

  /**
   * Run an async operation, and on recoverable failure (timeout, connection
   * closed) clean up, reconnect to the daemon, and retry once.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const recoverable = msg.includes('timed out')
        || msg.includes('connection closed')
        || msg.includes('Not connected');
      if (!recoverable) throw err;

      debug(`recoverable error, reconnecting: ${msg}`);
      await this.forceCleanup();
      await this.ensureConnected();
      return await fn();
    }
  }

  /**
   * Recovery after a failed operation: reset client state, and take the daemon
   * down only when it has actually stopped serving.
   *
   * A timeout on one call is not proof the daemon is broken (a biometric prompt
   * another client is sitting on can hold it), so we re-probe first. Killing a
   * daemon that is still healthy would strand every other varlock process
   * connected to it and ask the user for a fresh Touch ID.
   */
  private async forceCleanup(): Promise<void> {
    this.cleanup();

    if (await this.isDaemonResponsive()) {
      debug('daemon still responds to ping, reconnecting without restarting it');
      return;
    }

    // Try to kill the daemon by PID so we don't reconnect to a broken process,
    // then drop the bookkeeping files so the next spawn starts clean. The socket
    // and lock file are left to the next daemon, which clears them under the lock.
    const pid = readLiveDaemonPid();
    if (pid !== undefined) {
      killDaemonProcess(pid);
      cleanupDaemonFilesFor(pid);
    } else {
      cleanupDaemonFiles();
    }
  }

  /** Whether a daemon is currently answering on the socket */
  private async isDaemonResponsive(): Promise<boolean> {
    const probe = new DaemonClient();
    try {
      await probe.connectToSocket(getSocketPath());
      await probe.sendMessage({ action: 'ping' }, PROBE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    } finally {
      probe.cleanup();
    }
  }

  private connectToSocket(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.isConnected = true;
        this.buffer = Buffer.alloc(0);
        resolve();
      });

      socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        this.isConnected = false;
        reject(err);
      });

      socket.on('close', () => {
        this.isConnected = false;
        this.socket = null;
        // Reject all pending messages so callers don't hang
        for (const { reject: rej } of this.messageQueue.values()) {
          rej(new Error('Daemon connection closed'));
        }
        this.messageQueue.clear();
        this.buffer = Buffer.alloc(0);
      });

      socket.connect(socketPath);
    });
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + messageLength) break;

      const messageData = this.buffer.subarray(4, 4 + messageLength);
      this.buffer = this.buffer.subarray(4 + messageLength);

      try {
        const message = JSON.parse(messageData.toString());
        if (message.id && this.messageQueue.has(message.id)) {
          const { resolve: res, reject: rej } = this.messageQueue.get(message.id)!;
          this.messageQueue.delete(message.id);
          if (message.error) {
            rej(new DaemonError(String(message.error), message.errorCode));
          } else {
            res(message.result);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private sendMessage(message: Record<string, any>, timeoutMs = SEND_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.socket) {
        reject(new Error('Not connected to daemon'));
        return;
      }

      const messageId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const messageWithId = { ...message, id: messageId };
      const jsonData = JSON.stringify(messageWithId);
      const messageBytes = Buffer.from(jsonData, 'utf-8');

      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32LE(messageBytes.length, 0);

      // Timeout to prevent hanging forever on a stuck daemon
      const timeout = setTimeout(() => {
        this.messageQueue.delete(messageId);
        reject(new Error(`Daemon message timed out after ${timeoutMs}ms (action: ${message.action})`));
      }, timeoutMs);

      this.messageQueue.set(messageId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.socket.write(Buffer.concat([lengthBuf, messageBytes]));
    });
  }

  private async spawnDaemon(): Promise<void> {
    // WSL2: the Windows daemon listens on a Windows named pipe that Linux
    // sockets cannot connect to. All WSL2 biometric operations must bypass
    // DaemonClient and invoke the Windows binary directly via --via-daemon.
    // If we somehow reach this point on WSL2, fail fast with a clear message
    // rather than spawning a broken daemon or hanging indefinitely.
    if (isWSL()) {
      throw new Error(
        'DaemonClient is not supported on WSL2. The Windows encryption daemon uses a Windows named pipe that Linux socket APIs cannot connect to. Use the Windows binary directly instead.',
      );
    }

    const binaryPath = resolveNativeBinary();
    if (!binaryPath) {
      throw new Error('Native encryption binary not found — cannot start daemon');
    }

    const socketPath = getSocketPath();
    const pidPath = getPidPath();
    const isWindows = process.platform === 'win32';

    // Ensure PID directory exists (don't mkdir for Windows pipe paths)
    if (!isWindows) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    }
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });

    // Check for an existing daemon via PID
    const existingPid = readLiveDaemonPid();
    if (existingPid !== undefined) {
      // Process is alive, so verify it's actually responsive on the socket
      try {
        await this.connectToSocket(socketPath);
        return; // daemon is alive and accepting connections
      } catch {
        // Alive but socket unresponsive, so kill it and respawn
        debug(`daemon pid ${existingPid} alive but socket unresponsive, killing it`);
        killDaemonProcess(existingPid);
        cleanupDaemonFilesFor(existingPid);
      }
    }

    // The socket and lock file are intentionally left in place. A daemon that
    // wins the startup lock clears them itself; removing them here would pull
    // the socket out from under a daemon that is up but not yet recorded in the
    // PID file, leaving it orphaned while a second daemon takes its place.

    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, [
        'daemon',
        '--socket-path',
        socketPath,
        '--pid-path',
        pidPath,
      ], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        reject(new Error('Daemon failed to start within timeout'));
      }, 10000);

      let stdoutData = '';
      let stderrData = '';

      child.stdout!.on('data', (data: Buffer) => {
        stdoutData += data.toString();
        try {
          const parsed = JSON.parse(stdoutData);
          if (parsed.ready) {
            clearTimeout(timeout);
            child.unref();
            child.stdout!.destroy();
            child.stderr!.destroy();
            resolve();
          } else if (parsed.alreadyRunning) {
            // Another daemon won the lock (parallel-spawn race). The existing
            // daemon owns pidPath / daemon.info, so we just resolve and let
            // the caller connect to it.
            clearTimeout(timeout);
            child.unref();
            child.stdout!.destroy();
            child.stderr!.destroy();
            resolve();
          }
        } catch {
          // Incomplete JSON, keep buffering
        }
      });

      child.stderr!.on('data', (data: Buffer) => {
        stderrData += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn daemon: ${err.message}`));
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          const details = [
            stderrData.trim() && `stderr: ${stderrData.trim()}`,
            stdoutData.trim() && `stdout: ${stdoutData.trim()}`,
            `binary: ${binaryPath}`,
            `socket: ${socketPath}`,
          ].filter(Boolean).join('\n');
          reject(new Error(`Daemon exited with code ${code}\n${details}`));
        }
      });
    });
  }
}
