import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CacheStore, withDirLock } from './cache-store';

// mock localEncrypt to avoid needing real encryption keys
vi.mock('../local-encrypt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  ensureKey: vi.fn(async () => {}),
  encryptValue: vi.fn(async (value: string) => `encrypted:${value}`),
  decryptValue: vi.fn(async (value: string) => value.replace('encrypted:', '')),
}));

let tempDir: string;
vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => tempDir,
}));

/** short opts so the backstop deadline is reachable in a test */
const FAST = {
  waitMs: 5, timeoutMs: 300, staleMs: 10_000,
};

let lockPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-lock-test-'));
  lockPath = path.join(tempDir, 'locks', 'test.lock');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Fabricate a held lock dir owned by `pid` (defaults to a pid that is gone). */
function plantLock(opts: { pid?: number; host?: string; withOwner?: boolean } = {}) {
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  if (opts.withOwner === false) return;
  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: opts.pid ?? 999_999_999,
      host: opts.host ?? os.hostname(),
      token: 'planted-token',
    }),
  );
}

describe('withDirLock', () => {
  it('steals a lock owned by a dead process immediately', async () => {
    plantLock({ pid: 999_999_999 });

    const start = Date.now();
    const ran = await withDirLock(lockPath, FAST, () => 'ran');

    expect(ran).toBe('ran');
    // must not have waited out the deadline
    expect(Date.now() - start).toBeLessThan(FAST.timeoutMs);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('waits for a lock owned by a live process rather than stealing it', async () => {
    // our own pid is alive by definition; a foreign token means it is not ours to release
    plantLock({ pid: process.pid });
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }),
    );

    const fn = vi.fn(() => 'ran');
    await withDirLock(lockPath, { ...FAST, failOpen: true }, fn);

    // it fell through to the fail-open backstop rather than stealing early
    expect(fn).toHaveBeenCalledTimes(1);
    // the live holder's lock was left intact
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('does not steal a lock owned by another host', async () => {
    plantLock({ pid: 999_999_999, host: 'some-other-machine' });

    const fn = vi.fn(() => 'ran');
    await withDirLock(lockPath, { ...FAST, failOpen: true }, fn);

    // liveness is undecidable off-host, so the lock survives until it goes stale
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('steals a lock left with no owner metadata once past the grace window', async () => {
    plantLock({ withOwner: false });
    // backdate past OWNER_GRACE_MS (5s)
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(lockPath, old, old);

    const start = Date.now();
    const ran = await withDirLock(lockPath, FAST, () => 'ran');

    expect(ran).toBe('ran');
    expect(Date.now() - start).toBeLessThan(FAST.timeoutMs);
  });

  it('fails open at the backstop instead of throwing', async () => {
    plantLock({ pid: process.pid });
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }),
    );

    const result = await withDirLock(lockPath, { ...FAST, failOpen: true }, () => 'produced anyway');
    expect(result).toBe('produced anyway');
  });

  it('throws a message naming the remedy when fail-open is off', async () => {
    plantLock({ pid: process.pid });
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }),
    );

    await expect(withDirLock(lockPath, { ...FAST, failOpen: false }, () => 'x'))
      .rejects.toThrow(/varlock cache clear/);
  });

  it('propagates producer errors and releases the lock', async () => {
    await expect(withDirLock(lockPath, FAST, () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  describe('ownership', () => {
    it('does not delete a lock that was stolen and re-acquired by someone else', async () => {
      let observedInside = false;

      await withDirLock(lockPath, FAST, async () => {
        // simulate: this holder was judged stale, stolen, and a new owner took over
        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'new-owner' }),
        );
        observedInside = true;
      });

      expect(observedInside).toBe(true);
      // the new owner's lock must survive our release
      expect(fs.existsSync(lockPath)).toBe(true);
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'));
      expect(owner.token).toBe('new-owner');
    });

    it('re-enters a lock it already holds instead of deadlocking', async () => {
      const start = Date.now();
      const inner = await withDirLock(lockPath, FAST, async () => (
        // same lock path, from inside the critical section
        withDirLock(lockPath, FAST, () => 'inner ran')
      ));

      expect(inner).toBe('inner ran');
      expect(Date.now() - start).toBeLessThan(FAST.timeoutMs);
      // the outer release still cleans up
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('records itself as owner while held', async () => {
      await withDirLock(lockPath, FAST, () => {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'));
        expect(owner.pid).toBe(process.pid);
        expect(owner.host).toBe(os.hostname());
        expect(typeof owner.token).toBe('string');
      });
    });
  });
});

describe('CacheStore key locks', () => {
  const keyLockPathFor = (store: CacheStore, cacheKey: string) => path.join(
    store.getKeyLocksPath(),
    `${createHash('sha256').update(cacheKey).digest('hex')}.lock`,
  );

  it('surfaces the real producer error instead of a lock timeout when a lock is orphaned', async () => {
    const store = new CacheStore();
    const cacheKey = 'plugin:test:orphaned';
    // an interrupted run left a lock behind, owned by a process that is gone
    const orphan = keyLockPathFor(store, cacheKey);
    fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(orphan, 'owner.json'),
      JSON.stringify({ pid: 999_999_999, host: os.hostname(), token: 'gone' }),
    );

    const start = Date.now();
    await expect(store.getOrSet(cacheKey, 60_000, () => {
      throw new Error('awsParam(): Parameter "/test/x" not found');
    })).rejects.toThrow('Parameter "/test/x" not found');

    // the whole point: this used to block for 5 minutes
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('still deduplicates concurrent producers for the same key', async () => {
    const store = new CacheStore();
    const producer = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      return 'shared-value';
    });

    const [a, b] = await Promise.all([
      store.getOrSet('plugin:test:race', 60_000, producer),
      store.getOrSet('plugin:test:race', 60_000, producer),
    ]);

    expect(producer).toHaveBeenCalledTimes(1);
    expect(a?.value).toBe('shared-value');
    expect(b?.value).toBe('shared-value');
  });

  it('clearLocks removes orphaned key locks', async () => {
    const store = new CacheStore();
    const orphan = keyLockPathFor(store, 'plugin:test:whatever');
    fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
    expect(fs.existsSync(orphan)).toBe(true);

    store.clearLocks();

    expect(fs.existsSync(store.getKeyLocksPath())).toBe(false);
  });
});
