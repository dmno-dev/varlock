/**
 * Test harness for the fake daemon in `fake-daemon.mjs`.
 *
 * Sets up a throwaway user varlock dir, makes the fake script look like the
 * native helper binary, and gives tests a handle on what the daemon was asked.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DAEMON_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fake-daemon.mjs',
);

/**
 * A short-enough base for a unix socket path.
 *
 * macOS caps `sun_path` around 104 bytes and its `os.tmpdir()` is already deep,
 * so a nested socket under it can quietly fail to bind. /tmp is the escape hatch.
 */
function shortTempBase(): string {
  const preferred = os.tmpdir();
  return preferred.length > 24 && fs.existsSync('/tmp') ? '/tmp' : preferred;
}

export interface FakeDaemonConfig {
  protocolVersion?: number;
  sessionId?: string;
  /** ciphertext -> plaintext, since the fake does no real crypto */
  plaintexts?: Record<string, string>;
  /** make `unlock-session` fail with this code */
  unlockError?: { code: string; message?: string };
  /** drop grants once, just before the next decrypt-v2, to stage the retry */
  dropGrantsBeforeDecrypt?: boolean;
}

export interface RecordedCall {
  action: string;
  payload: Record<string, unknown>;
  pid: number;
}

export class FakeDaemonHarness {
  readonly userVarlockDir: string;
  readonly socketDir: string;
  readonly socketPath: string;
  readonly binaryPath: string;
  private manual: ChildProcess | undefined;

  constructor() {
    this.userVarlockDir = fs.mkdtempSync(path.join(shortTempBase(), 'vl-'));
    this.socketDir = path.join(this.userVarlockDir, 'local-encrypt');
    this.socketPath = path.join(this.socketDir, 'daemon.sock');
    fs.mkdirSync(this.socketDir, { recursive: true });

    // a copy rather than the original, so its mtime is ours to control and the
    // client's stale-binary check compares against something stable
    this.binaryPath = path.join(this.userVarlockDir, 'varlock-local-encrypt');
    fs.copyFileSync(FAKE_DAEMON_SCRIPT, this.binaryPath);
    fs.chmodSync(this.binaryPath, 0o755);

    this.setConfig({});
  }

  setConfig(config: FakeDaemonConfig) {
    fs.writeFileSync(
      path.join(this.socketDir, 'fake-daemon.json'),
      JSON.stringify(config, null, 2),
    );
  }

  /** Every message the daemon has been sent, in order, across restarts */
  calls(): Array<RecordedCall> {
    const logPath = path.join(this.socketDir, 'fake-daemon-calls.jsonl');
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordedCall);
  }

  callsOf(action: string): Array<RecordedCall> {
    return this.calls().filter((call) => call.action === action);
  }

  clearCalls() {
    try {
      fs.unlinkSync(path.join(this.socketDir, 'fake-daemon-calls.jsonl'));
    } catch { /* nothing logged yet */ }
  }

  /**
   * Start a daemon by hand, the way one left running from an earlier varlock
   * would already be there. Writes the same `daemon.info` the client writes when
   * it spawns one, so the stale-*binary* check does not fire and whatever the
   * test is actually about gets a chance to happen.
   */
  async startExistingDaemon(): Promise<number> {
    const pidPath = path.join(this.socketDir, 'daemon.pid');
    const child = spawn(this.binaryPath, ['daemon', '--socket-path', this.socketPath, '--pid-path', pidPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.manual = child;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake daemon did not start')), 10_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('"ready"')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    fs.writeFileSync(path.join(this.socketDir, 'daemon.info'), JSON.stringify({
      binaryPath: this.binaryPath,
      binaryMtimeMs: fs.statSync(this.binaryPath).mtimeMs,
    }));
    return child.pid!;
  }

  /** Whether a process is still around, for asserting a restart really happened */
  static isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  cleanup() {
    this.manual?.kill('SIGKILL');
    // whatever the client spawned during the test is detached from us
    try {
      const pid = parseInt(fs.readFileSync(path.join(this.socketDir, 'daemon.pid'), 'utf-8').trim(), 10);
      if (pid) process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
    fs.rmSync(this.userVarlockDir, { recursive: true, force: true });
  }
}
