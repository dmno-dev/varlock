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

function getSocketDir(): string {
  return path.join(getUserVarlockDir(), 'local-encrypt');
}

function getSocketPath(): string {
  if (process.platform === 'win32') {
    // Windows named pipe
    return `\\\\.\\pipe\\varlock-local-encrypt-${process.pid}`;
  }
  return path.join(getSocketDir(), 'daemon.sock');
}

function getPidPath(): string {
  return path.join(getSocketDir(), 'daemon.pid');
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
    try {
      await this.connectToSocket(socketPath);
      return;
    } catch {
      // Daemon not running, spawn it
    }

    await this.spawnDaemon();
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

    fs.mkdirSync(path.dirname(socketPath), { recursive: true });

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

    // Clean up stale socket and PID files before spawning
    for (const file of [socketPath, pidPath]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }

    // Verify socket file is actually gone — if not, something is very wrong
    if (fs.existsSync(socketPath)) {
      throw new Error(`Failed to clean up stale socket file: ${socketPath}`);
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
