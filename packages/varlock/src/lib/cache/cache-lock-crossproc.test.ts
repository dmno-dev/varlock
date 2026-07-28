import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * End-to-end check of the scenario from the bug report: a varlock process is
 * killed mid-resolution while holding a cache key lock, and the next run must
 * not inherit a multi-minute stall.
 *
 * This deliberately uses a real child process rather than a fabricated lock
 * dir, so the owner metadata is written by the same code path that reads it.
 */

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const CACHE_KEY = 'plugin:test:crossproc';

const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0;

let tempHome: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-xproc-'));
});

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function keyLockPath(): string {
  const hash = createHash('sha256').update(CACHE_KEY).digest('hex');
  return path.join(tempHome, 'varlock', 'cache', 'varlock-default.json.keylocks', `${hash}.lock`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/** Wait until the child has actually taken the lock (owner metadata present). */
async function waitForLockHeld(timeoutMs = 20_000): Promise<void> {
  const ownerFile = path.join(keyLockPath(), 'owner.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(ownerFile)) return;
    await sleep(25);
  }
  throw new Error('child never acquired the lock');
}

describe.runIf(hasBun)('orphaned lock left by a killed process', () => {
  it('is reclaimed immediately, surfacing the real producer error', async () => {
    const holderScript = path.join(tempHome, 'holder.ts');
    fs.writeFileSync(holderScript, `
      import { CacheStore } from ${JSON.stringify(path.join(thisDir, 'cache-store.ts'))};
      const store = new CacheStore();
      // never resolves, stands in for a hung API call or an unanswered prompt
      store.getOrSet(${JSON.stringify(CACHE_KEY)}, 60_000, () => new Promise(() => {})).catch(() => {});
      setInterval(() => {}, 1_000);
    `);

    child = spawn('bun', ['run', holderScript], {
      env: { ...process.env, XDG_CONFIG_HOME: tempHome },
      stdio: 'ignore',
    });

    await waitForLockHeld();

    // hard kill: no exit handler runs, so the lock dir is left behind
    child.kill('SIGKILL');
    await sleep(200);
    expect(fs.existsSync(keyLockPath())).toBe(true);

    // a fresh process must now reclaim it rather than waiting out the deadline
    const runnerScript = path.join(tempHome, 'runner.ts');
    fs.writeFileSync(runnerScript, `
      import { CacheStore } from ${JSON.stringify(path.join(thisDir, 'cache-store.ts'))};
      const store = new CacheStore();
      store.getOrSet(${JSON.stringify(CACHE_KEY)}, 60_000, () => {
        throw new Error('awsParam(): Parameter "/test/x" not found');
      }).then(
        () => { console.log('UNEXPECTED_SUCCESS'); },
        (err) => { console.log('ERR:' + err.message); },
      );
    `);

    const start = Date.now();
    const result = spawnSync('bun', ['run', runnerScript], {
      env: { ...process.env, XDG_CONFIG_HOME: tempHome },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const elapsed = Date.now() - start;

    expect(result.stdout).toContain('Parameter "/test/x" not found');
    expect(result.stdout).not.toContain('Timed out waiting for cache lock');
    // before liveness detection this blocked for the full 5 minute deadline
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('is released on SIGINT, and the signal still terminates the process', async () => {
    const holderScript = path.join(tempHome, 'holder.ts');
    fs.writeFileSync(holderScript, `
      import { CacheStore } from ${JSON.stringify(path.join(thisDir, 'cache-store.ts'))};
      const store = new CacheStore();
      store.getOrSet(${JSON.stringify(CACHE_KEY)}, 60_000, () => new Promise(() => {})).catch(() => {});
      setInterval(() => {}, 1_000);
    `);

    child = spawn('bun', ['run', holderScript], {
      env: { ...process.env, XDG_CONFIG_HOME: tempHome },
      stdio: 'ignore',
    });

    await waitForLockHeld();

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child!.on('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGINT');
    const outcome = await exited;

    // the lock is gone rather than left for liveness detection to clean up
    expect(fs.existsSync(keyLockPath())).toBe(false);
    // and Ctrl+C still ends the process (re-raised, not swallowed)
    expect(outcome.signal === 'SIGINT' || outcome.code === 130).toBe(true);
  }, 60_000);

  it('is left alone while its owner is still alive', async () => {
    const holderScript = path.join(tempHome, 'holder.ts');
    fs.writeFileSync(holderScript, `
      import { CacheStore } from ${JSON.stringify(path.join(thisDir, 'cache-store.ts'))};
      const store = new CacheStore();
      store.getOrSet(${JSON.stringify(CACHE_KEY)}, 60_000, () => new Promise(() => {})).catch(() => {});
      setInterval(() => {}, 1_000);
    `);

    child = spawn('bun', ['run', holderScript], {
      env: { ...process.env, XDG_CONFIG_HOME: tempHome },
      stdio: 'ignore',
    });

    await waitForLockHeld();
    const ownerBefore = fs.readFileSync(path.join(keyLockPath(), 'owner.json'), 'utf-8');

    // a second process must wait on the live holder, not steal from it
    const waiterScript = path.join(tempHome, 'waiter.ts');
    fs.writeFileSync(waiterScript, `
      import { CacheStore } from ${JSON.stringify(path.join(thisDir, 'cache-store.ts'))};
      const store = new CacheStore();
      store.getOrSet(${JSON.stringify(CACHE_KEY)}, 60_000, () => 'STOLE_IT').catch(() => {});
      setInterval(() => {}, 1_000);
    `);
    const waiter = spawn('bun', ['run', waiterScript], {
      env: { ...process.env, XDG_CONFIG_HOME: tempHome },
      stdio: 'ignore',
    });

    try {
      await sleep(3_000);
      // the original owner still holds it
      expect(fs.readFileSync(path.join(keyLockPath(), 'owner.json'), 'utf-8')).toBe(ownerBefore);
    } finally {
      waiter.kill('SIGKILL');
    }
  }, 60_000);
});
