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
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { getUserVarlockDir } from '../user-config-dir';
import { resolveNativeBinary } from './binary-resolver';
import type { KeychainItemMeta, KeychainItemRef } from './types';

function debug(msg: string) {
  if (process.env.VARLOCK_DEBUG) {
    process.stderr.write(`[varlock:daemon-client] ${msg}\n`);
  }
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

/**
 * Check whether the currently running daemon was spawned from the same binary
 * we would spawn now. Compares the resolved binary path and its mtime against
 * the values recorded in daemon.info when the daemon was last started.
 *
 * Returns the stale PID (to kill) if there's a mismatch or no info file
 * exists (daemon predates version tracking), or undefined if daemon is current.
 */
function checkDaemonBinaryStale(): number | undefined {
  const infoPath = getDaemonInfoPath();
  const pidPath = getPidPath();

  let info: { binaryPath: string; binaryMtimeMs: number } | undefined;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
  } catch {
    // No info file — daemon predates version tracking, treat as stale
  }

  const currentBinaryPath = resolveNativeBinary();
  if (!currentBinaryPath) return undefined; // no binary available at all

  if (info) {
    // Path changed (e.g. new npm install, different resolution strategy)
    if (currentBinaryPath !== info.binaryPath) {
      debug(`daemon binary path changed: ${info.binaryPath} → ${currentBinaryPath}`);
    } else {
      // Same path — check if the file was updated in place
      try {
        const stat = fs.statSync(currentBinaryPath);
        if (stat.mtimeMs === info.binaryMtimeMs) {
          debug('daemon binary is current — no restart needed');
          return undefined; // same binary, daemon is current
        }
        debug(`daemon binary mtime changed: ${info.binaryMtimeMs} → ${stat.mtimeMs}`);
      } catch {
        return undefined; // can't stat, assume OK
      }
    }
  } else {
    debug('no daemon.info file — treating running daemon as stale');
  }

  // Binary changed — read PID so caller can kill the stale daemon
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    process.kill(pid, 0); // verify process is alive
    return pid;
  } catch {
    return undefined; // stale PID or process already gone
  }
}

/** Write daemon.info recording which binary was used to spawn the daemon */
function writeDaemonInfo(binaryPath: string): void {
  try {
    const stat = fs.statSync(binaryPath);
    fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({
      binaryPath,
      binaryMtimeMs: stat.mtimeMs,
    }));
  } catch {
    // Non-fatal — version checking just won't work this time
  }
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
  /** Set after we spawn a daemon in this process — skip stale check to avoid restart loops */
  private spawnedInThisProcess = false;

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

    // Check if a running daemon was spawned from a stale binary
    const stalePid = this.spawnedInThisProcess ? undefined : checkDaemonBinaryStale();
    if (stalePid) {
      debug(`killing stale daemon (pid ${stalePid}) — binary has been updated`);
      try {
        process.kill(stalePid, 'SIGTERM');
      } catch {
        // already gone
      }
      // Clean up so spawnDaemon doesn't think a daemon is still running
      for (const file of [getPidPath(), getDaemonInfoPath()]) {
        try {
          fs.unlinkSync(file);
        } catch { /* ignore */ }
      }
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(socketPath);
        } catch { /* ignore */ }
      }
    } else {
      try {
        await this.connectToSocket(socketPath);
        return;
      } catch {
        // Daemon not running, spawn it
      }
    }

    try {
      await this.spawnDaemon();
    } catch {
      // Another process may have won the race to spawn the daemon.
      // Wait briefly for it to be ready, then try connecting.
      await new Promise<void>((r) => {
        setTimeout(r, 1000);
      });
    }
    await this.connectToSocket(socketPath);
  }

  async decrypt(ciphertext: string, keyId = 'varlock-default'): Promise<string> {
    await this.ensureConnected();
    const result = await this.sendMessage({
      action: 'decrypt',
      payload: { ciphertext, keyId },
    });
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(String(result.error));
    }
    return String(result);
  }

  async promptSecret(opts?: {
    itemKey?: string;
    message?: string;
    keyId?: string;
  }): Promise<string | undefined> {
    await this.ensureConnected();
    try {
      const result = await this.sendMessage({
        action: 'prompt-secret',
        payload: {
          itemKey: opts?.itemKey,
          message: opts?.message,
          keyId: opts?.keyId,
        },
      });
      if (result && typeof result === 'object' && 'ciphertext' in result) {
        return result.ciphertext as string;
      }
      return undefined;
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return undefined;
      throw err;
    }
  }

  async invalidateSession(): Promise<void> {
    await this.ensureConnected();
    await this.sendMessage({ action: 'invalidate-session' });
  }

  async keychainGet(opts: { service?: string; account?: string; keychain?: string; field?: string }): Promise<string> {
    await this.ensureConnected();
    const result = await this.sendMessage({
      action: 'keychain-get',
      payload: opts,
    });
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(String(result.error));
    }
    return String(result);
  }

  async keychainSearch(opts?: { query?: string; keychain?: string }): Promise<Array<KeychainItemMeta>> {
    await this.ensureConnected();
    const result = await this.sendMessage({
      action: 'keychain-search',
      payload: opts ?? {},
    });
    return (result ?? []) as Array<KeychainItemMeta>;
  }

  async keychainPick(opts?: { itemKey?: string }): Promise<KeychainItemRef | undefined> {
    await this.ensureConnected();
    try {
      const result = await this.sendMessage({
        action: 'keychain-pick',
        payload: { itemKey: opts?.itemKey },
      });
      if (result && typeof result === 'object' && 'service' in result) {
        return result as KeychainItemRef;
      }
      return undefined;
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return undefined;
      throw err;
    }
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
            rej(new Error(message.error));
          } else {
            res(message.result);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private sendMessage(message: Record<string, any>): Promise<any> {
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

      this.messageQueue.set(messageId, { resolve, reject });
      this.socket.write(Buffer.concat([lengthBuf, messageBytes]));
    });
  }

  private async spawnDaemon(): Promise<void> {
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

    // Check for existing daemon via PID
    if (fs.existsSync(pidPath)) {
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(pid, 0); // Throws if process doesn't exist
        // Process is alive — wait briefly and let ensureConnected retry
        await new Promise<void>((r) => {
          setTimeout(r, 500);
        });
        return;
      } catch {
        // Stale PID file — clean up both PID and socket
      }
    }

    // Clean up stale files before spawning
    // On Windows, named pipes don't leave files — only clean PID and Unix sockets
    if (!isWindows) {
      for (const file of [socketPath, pidPath, getDaemonInfoPath()]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
      // Verify socket file is actually gone
      if (fs.existsSync(socketPath)) {
        throw new Error(`Failed to clean up stale socket file: ${socketPath}`);
      }
    } else {
      // Clean PID + info files on Windows (named pipes don't leave socket files)
      for (const file of [pidPath, getDaemonInfoPath()]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }

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
            writeDaemonInfo(binaryPath);
            this.spawnedInThisProcess = true;
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
