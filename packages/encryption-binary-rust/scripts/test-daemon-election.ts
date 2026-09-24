#!/usr/bin/env bun

/**
 * End-to-end check that the daemon stays single-instance.
 *
 * Usage:
 *   bun run scripts/test-daemon-election.ts <path-to-varlock-local-encrypt>
 *
 * 1. Starts many daemons at once on a private socket/pipe: exactly one must
 *    report `ready`, the rest `alreadyRunning`, and every client must reach the
 *    winner.
 * 2. Kills the winner while clients still hold connections (on Windows, also
 *    raw pipe handles that nothing closes), then starts many daemons at once
 *    again: exactly one must win and serve.
 *
 * On Windows, step 2 covers daemon replacement while clients of the dead
 * daemon still hold pipe handles, the case that made FILE_FLAG_FIRST_PIPE_INSTANCE
 * look unsafe as the election.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const binaryPath = process.argv[2];
if (!binaryPath || !fs.existsSync(binaryPath)) {
  console.error('usage: bun run scripts/test-daemon-election.ts <path-to-varlock-local-encrypt>');
  process.exit(2);
}

const CONCURRENCY = 12;
const CLIENTS = 6;
const isWindows = process.platform === 'win32';
const runId = `${process.pid}-${Date.now()}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-election-'));
const socketPath = isWindows
  ? `\\\\.\\pipe\\varlock-election-test-${runId}`
  : path.join(tmpDir, 'daemon.sock');
const pidPath = path.join(tmpDir, 'daemon.pid');

const allDaemons: Array<ChildProcess> = [];
const openSockets: Array<net.Socket> = [];
const rawHandles: Array<number> = [];

type LaunchResult = { child: ChildProcess, outcome: 'ready' | 'alreadyRunning' | 'failed', detail: string };

function launchDaemon(): Promise<LaunchResult> {
  const child = spawn(binaryPath, ['daemon', '--socket-path', socketPath, '--pid-path', pidPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  allDaemons.push(child);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const state = { settled: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const settle = (outcome: LaunchResult['outcome'], detail: string) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(state.timer);
      resolve({ child, outcome, detail });
    };
    state.timer = setTimeout(() => settle('failed', `timed out; stdout=${stdout} stderr=${stderr}`), 15_000);
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) settle('ready', line);
          else if (parsed.alreadyRunning) settle('alreadyRunning', line);
        } catch {
          // incomplete line
        }
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => settle('failed', `exited with ${code}; stdout=${stdout} stderr=${stderr}`));
  });
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // allowHalfOpen keeps the handle open after the daemon goes away, like a
    // client that hasn't noticed yet.
    const socket = net.connect({ path: socketPath, allowHalfOpen: true });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function ping(socket: net.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ id: 'p', action: 'ping' }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('ping timed out')), 5_000);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const res = JSON.parse(buf.subarray(4, 4 + n).toString());
      if (!res.result?.pong) reject(new Error(`bad ping response: ${JSON.stringify(res)}`));
      else resolve(res.result.pid);
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(Buffer.concat([len, body]));
  });
}

async function pingFresh(): Promise<number> {
  const socket = await connect();
  openSockets.push(socket);
  return ping(socket);
}

/**
 * Open a raw client handle to the pipe. Back-to-back opens can find no free
 * instance while the daemon is still creating the next one (ERROR_PIPE_BUSY);
 * libuv waits that out for net.connect, so do the same here.
 */
async function openRawPipe(): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.openSync(socketPath, 'r+');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= 100) throw err;
      await new Promise((r) => {
        setTimeout(r, 20);
      });
    }
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

let failures = 0;
function check(ok: boolean, message: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

/** Start CONCURRENCY daemons at once and check exactly one wins and serves */
async function electOne(label: string): Promise<ChildProcess | undefined> {
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => launchDaemon()));
  const winners = results.filter((r) => r.outcome === 'ready');
  const losers = results.filter((r) => r.outcome === 'alreadyRunning');
  const failed = results.filter((r) => r.outcome === 'failed');
  for (const f of failed) console.log(`     failed launch: ${f.detail}`);
  check(winners.length === 1, `${label}: exactly one daemon ready (got ${winners.length})`);
  check(losers.length === CONCURRENCY - 1, `${label}: the other ${CONCURRENCY - 1} report alreadyRunning (got ${losers.length})`);

  await Promise.all(losers.map((l) => waitForExit(l.child)));
  check(losers.every((l) => l.child.exitCode === 0), `${label}: every loser exits 0`);

  const alive = allDaemons.filter((c) => c.exitCode === null && c.signalCode === null);
  check(alive.length === 1, `${label}: one daemon process still running (got ${alive.length})`);

  const winnerPids = winners.map((w) => w.child.pid);
  const pongPids = await Promise.all(Array.from({ length: CLIENTS }, () => pingFresh()));
  check(
    pongPids.every((pid) => winnerPids.includes(pid) && pid === pongPids[0]),
    `${label}: all ${CLIENTS} clients reach the same winning daemon (pids ${[...new Set(pongPids)].join(',')})`,
  );
  if (fs.existsSync(pidPath)) {
    const recorded = Number(fs.readFileSync(pidPath, 'utf8').trim());
    check(winnerPids.includes(recorded), `${label}: pid file names the winner (${recorded})`);
  } else {
    check(false, `${label}: pid file written`);
  }
  return winners[0]?.child;
}

async function main() {
  console.log(`platform=${process.platform} socket=${socketPath}`);

  const first = await electOne('concurrent start');

  if (first) {
    // Hold extra client handles open across the kill. On Windows, a raw
    // CreateFile handle to the pipe stays open until closed explicitly, like a
    // client that hasn't noticed its daemon is gone.
    if (isWindows) {
      for (let i = 0; i < 3; i++) rawHandles.push(await openRawPipe());
    }
    first.kill('SIGKILL');
    await waitForExit(first);
    check(true, `killed daemon ${first.pid} with ${openSockets.length} sockets and ${rawHandles.length} raw handles still open`);
    if (isWindows) {
      // Diagnostic only: whether the lingering handles keep the pipe name alive
      let stillNamed = false;
      try {
        fs.closeSync(fs.openSync(socketPath, 'r+'));
        stillNamed = true;
      } catch (err) {
        stillNamed = (err as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      console.log(`     pipe name after kill: ${stillNamed ? 'still present' : 'gone'}`);
    }

    await electOne('restart after kill');
  }

  for (const s of openSockets) s.destroy();
  for (const h of rawHandles) fs.closeSync(h);
  for (const c of allDaemons) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await Promise.all(allDaemons.map(waitForExit));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} check(s) failed` : '\nall election checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  for (const c of allDaemons) c.kill('SIGKILL');
  process.exit(1);
});
