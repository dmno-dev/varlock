/**
 * Daemon lifecycle tests.
 *
 * The staleness helpers are pure and run everywhere. The lifecycle tests drive
 * the real daemon binary, so they are skipped unless one has been built for this
 * platform. They cover the failure mode where several varlock processes start at
 * once (an MCP host launching a dozen stdio servers, a parallel task runner) and
 * end up with more than one daemon, which means more than one biometric prompt.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Unix socket paths are capped at ~104 bytes, so the daemon state dir has to be
// short. os.tmpdir() on macOS is not (/var/folders/...).
const testDir = fs.mkdtempSync('/tmp/vlk-daemon-');

vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => testDir,
}));

// Lets a test pretend the client lives in another project, i.e. resolves the
// daemon binary from a different install location.
const resolverState = vi.hoisted(() => ({ binaryOverride: undefined as string | undefined }));
vi.mock('./binary-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./binary-resolver')>();
  return {
    ...actual,
    resolveNativeBinary: () => resolverState.binaryOverride ?? actual.resolveNativeBinary(),
  };
});

const socketDir = path.join(testDir, 'local-encrypt');
const socketPath = path.join(socketDir, 'daemon.sock');
const pidPath = path.join(socketDir, 'daemon.pid');
const infoPath = path.join(socketDir, 'daemon.info');

let daemonClient: typeof import('./daemon-client');
let binaryPath: string | undefined;

function readPidFile(): number | undefined {
  try {
    return parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs of every daemon currently serving this test's socket path */
function runningDaemonPids(): Array<number> {
  const result = spawnSync('pgrep', ['-f', `daemon --socket-path ${socketPath}`], { encoding: 'utf-8' });
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid));
}

/** Start a daemon directly (bypassing the client) and resolve with its first line of output */
function startDaemonDirectly(): Promise<{ pid: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath!, ['daemon', '--socket-path', socketPath, '--pid-path', pidPath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`daemon produced no output: ${output}`)), 10_000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (!output.includes('\n')) return;
      clearTimeout(timeout);
      child.unref();
      resolve({ pid: child.pid!, output });
    });
    child.on('error', reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise<void>((r) => {
      setTimeout(r, 50);
    });
  }
}

/**
 * Copy the built app bundle elsewhere, as another project's install would be.
 * With `resign`, the copy is ad-hoc re-signed, which changes the executable's
 * bytes: a stand-in for a varlock release that shipped a different daemon.
 */
function copyAppBundle(name: string, opts?: { resign?: boolean }): string | undefined {
  const appDir = binaryPath!.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  const destDir = path.join(testDir, 'installs', name);
  fs.mkdirSync(destDir, { recursive: true });
  const destApp = path.join(destDir, path.basename(appDir));
  spawnSync('cp', ['-R', appDir, destApp]);
  if (opts?.resign) {
    const signed = spawnSync('codesign', ['--force', '--sign', '-', destApp]);
    if (signed.status !== 0) return undefined;
  }
  return path.join(destApp, path.relative(appDir, binaryPath!));
}

/** Connect a fresh client using the given binary, then return the running daemon PIDs */
async function connectWith(binary: string | undefined): Promise<Array<number>> {
  resolverState.binaryOverride = binary;
  const client = new daemonClient.DaemonClient();
  try {
    await client.ensureConnected();
  } finally {
    client.cleanup();
    resolverState.binaryOverride = undefined;
  }
  return runningDaemonPids();
}

function killAllDaemons() {
  for (const pid of runningDaemonPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

beforeEach(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  vi.resetModules();
  daemonClient = await import('./daemon-client');
  const resolver = await import('./binary-resolver');
  binaryPath = process.platform === 'darwin' ? resolver.resolveNativeBinary() : undefined;
});

afterEach(async () => {
  killAllDaemons();
  await waitFor(() => runningDaemonPids().length === 0).catch(() => {
    // best effort: a wedged daemon shouldn't fail the suite
  });
  fs.rmSync(socketDir, { recursive: true, force: true });
});

describe('shouldReplaceDaemon', () => {
  it('keeps a daemon running the same binary', () => {
    expect(daemonClient.shouldReplaceDaemon('abc', 'abc')).toBe(false);
  });

  it('replaces a daemon running a different binary', () => {
    expect(daemonClient.shouldReplaceDaemon('abc', 'def')).toBe(true);
  });

  it('replaces a daemon too old to report its binary', () => {
    expect(daemonClient.shouldReplaceDaemon(undefined, 'def')).toBe(true);
  });

  it('leaves the daemon alone when we cannot hash our own binary', () => {
    expect(daemonClient.shouldReplaceDaemon('abc', undefined)).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin')('daemon lifecycle', () => {
  it('keeps the winner\'s PID file when a second daemon loses the startup race', async () => {
    if (!binaryPath) return; // no built binary available

    const first = await startDaemonDirectly();
    expect(readPidFile()).toBe(first.pid);

    const second = await startDaemonDirectly();
    expect(second.output).toContain('alreadyRunning');
    await waitFor(() => !isAlive(second.pid));

    // The loser must not leave the PID file pointing at itself: every later
    // client would then read a dead PID and treat the live daemon as garbage.
    expect(readPidFile()).toBe(first.pid);
    expect(runningDaemonPids()).toEqual([first.pid]);
  });

  it('records the binary it was started from', async () => {
    if (!binaryPath) return;

    const { pid } = await startDaemonDirectly();
    await waitFor(() => fs.existsSync(infoPath));

    expect(JSON.parse(fs.readFileSync(infoPath, 'utf-8'))).toMatchObject({ binaryPath });
    expect(readPidFile()).toBe(pid);
  });

  it('does not replace a healthy daemon when the PID file is stale', async () => {
    if (!binaryPath) return;

    const { pid } = await startDaemonDirectly();
    // Simulate the bookkeeping left behind by an older varlock, or by a daemon
    // that was killed without cleaning up after itself.
    fs.writeFileSync(pidPath, '999999');
    fs.rmSync(infoPath, { force: true });

    const client = new daemonClient.DaemonClient();
    await client.ensureConnected();
    client.cleanup();

    expect(runningDaemonPids()).toEqual([pid]);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('shares one daemon between installs of an identical binary', async () => {
    if (!binaryPath) return;

    // e.g. two projects on different varlock versions that didn't change the
    // daemon: same bytes, different install paths
    const otherInstall = copyAppBundle('same-binary');
    const seen = [
      await connectWith(binaryPath),
      await connectWith(otherInstall),
      await connectWith(binaryPath),
    ];

    expect(seen[0]).toHaveLength(1);
    expect(seen).toEqual([seen[0], seen[0], seen[0]]);
  }, 30_000);

  it('swaps in the right daemon when moving between different binaries', async () => {
    if (!binaryPath) return;

    const otherBuild = copyAppBundle('different-binary', { resign: true });
    if (!otherBuild) return; // codesign unavailable

    const [first] = await connectWith(binaryPath);
    const afterOther = await connectWith(otherBuild);
    const afterBack = await connectWith(binaryPath);

    expect(afterOther).toHaveLength(1);
    expect(afterOther[0]).not.toBe(first);
    expect(afterBack).toHaveLength(1);
    expect(afterBack[0]).not.toBe(afterOther[0]);
  }, 30_000);

  it('converges on a single daemon when many clients connect at once', async () => {
    if (!binaryPath) return;

    const clients = Array.from({ length: 12 }, () => new daemonClient.DaemonClient());
    await Promise.all(clients.map((client) => client.ensureConnected()));

    const pids = runningDaemonPids();
    expect(pids).toHaveLength(1);
    expect(readPidFile()).toBe(pids[0]);

    for (const client of clients) client.cleanup();
  }, 30_000);
});
