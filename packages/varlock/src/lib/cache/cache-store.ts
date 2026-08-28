import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { getUserVarlockDir } from '../user-config-dir';
import * as localEncrypt from '../local-encrypt';
import { createDebug } from '../debug';

const debug = createDebug('varlock:cache');

const FILE_LOCK_OPTS = { waitMs: 25, timeoutMs: 5_000, staleMs: 30_000 };
/**
 * The key lock serializes the producer (an API call, a biometric unlock, a CLI
 * prompt) across processes, so waiting is normal and the deadline is only a
 * backstop for a holder that is alive but wedged. Orphaned locks are handled by
 * liveness detection, not by this timeout.
 */
const KEY_LOCK_OPTS = {
  waitMs: 50, timeoutMs: 5 * 60_000, staleMs: 10 * 60_000, failOpen: true,
};

/** Metadata written into a lock dir identifying its owner */
const LOCK_OWNER_FILE = 'owner.json';
/**
 * How long after creation a lock dir may lack owner metadata before we treat it
 * as an orphan. Covers the sub-millisecond gap between `mkdir` and writing the
 * owner file, and locks left by varlock versions predating owner metadata.
 */
const OWNER_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

type LockOwner = { pid: number; host: string; token: string };

type LockOpts = { waitMs: number; timeoutMs: number; staleMs: number; failOpen?: boolean };

/** Lock dirs currently held by this process, released on interrupt/exit */
const heldLocks = new Map<string, string>();
let cleanupRegistered = false;

/**
 * Lock dirs held by the *current async call stack*.
 *
 * Distinguishes a re-entrant call (nested inside the critical section, so it
 * already owns the lock) from a concurrent sibling in the same process (which
 * must still wait). A process-global set cannot tell those apart.
 */
const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const raw = fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid !== 'number' || typeof parsed?.host !== 'string' || typeof parsed?.token !== 'string') {
      return undefined;
    }
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process that owns a lock is still running.
 *
 * Only decidable for locks owned on this host. A recycled pid reads as alive,
 * which fails safe: we keep waiting and fall back to the mtime staleness check.
 */
function isLockOwnerAlive(owner: LockOwner): boolean {
  if (owner.host !== os.hostname()) return true;
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user
    return err?.code === 'EPERM';
  }
}

/** Atomically discard a lock dir. Only one racing waiter can win the rename. */
function stealLock(lockPath: string): void {
  const graveyard = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  fs.renameSync(lockPath, graveyard);
  fs.rmSync(graveyard, { recursive: true, force: true });
}

/**
 * Release a lock dir, but only if this process still owns it.
 *
 * Without the token check a holder that was (correctly) judged stale and stolen
 * from would delete the *new* owner's lock on its way out, letting two
 * processes run the same producer concurrently.
 */
function releaseLock(lockPath: string, token: string | undefined): void {
  try {
    if (token !== undefined) {
      const owner = readLockOwner(lockPath);
      if (owner && owner.token !== token) {
        debug('not releasing %s, lock was stolen by pid %d', lockPath, owner.pid);
        return;
      }
    }
    stealLock(lockPath);
  } catch {
    // already gone, or another process won a concurrent steal
  } finally {
    heldLocks.delete(lockPath);
  }
}

/**
 * Best-effort release of every lock this process holds.
 *
 * Ctrl+C at a biometric or password prompt is the common way locks get
 * orphaned, and the prompt-owning CLI often inherits stdin, so the signal hits
 * the whole process group.
 */
function registerLockCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const releaseAll = () => {
    for (const [lockPath, token] of [...heldLocks]) releaseLock(lockPath, token);
  };
  process.on('exit', releaseAll);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    // `once`, then re-raise: attaching any listener suppresses Node's default
    // termination, so we hand the signal back rather than picking an exit code.
    // Deliberately does not exit on its own: `varlock run` installs its own
    // forwarders, and racing them would break child signal delivery.
    try {
      process.once(signal, () => {
        releaseAll();
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      });
    } catch {
      // some signals (e.g. SIGQUIT) can't be listened for on every platform
    }
  }
}

/**
 * Cross-process mutual exclusion via atomic `mkdir` of a lock directory.
 *
 * A lock is considered abandoned when its owning process is gone (checked via
 * pid liveness), falling back to an mtime staleness window when ownership
 * can't be determined. Held locks have their mtime refreshed periodically so a
 * slow holder is not treated as stale.
 *
 * @internal exported so lock semantics can be tested with short timeouts
 */
export async function withDirLock<T>(
  lockPath: string,
  opts: LockOpts,
  fn: () => Promise<T> | T,
): Promise<T> {
  // already held further up this call stack, e.g. `cache(key="x", cache(key="x", …))`,
  // or a plugin whose producer re-enters the same key. Mutual exclusion is
  // already satisfied, so proceed rather than self-deadlocking until the deadline.
  const outerHeld = lockContext.getStore();
  if (outerHeld?.has(lockPath)) {
    debug('re-entering lock %s already held by this call stack', lockPath);
    return await fn();
  }

  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + opts.timeoutMs;
  let acquired = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // parent dir missing — create it (0700: keys can leak secret topology) and retry
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        continue;
      }
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      try {
        const owner = readLockOwner(lockPath);
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (owner ? !isLockOwnerAlive(owner) : ageMs > OWNER_GRACE_MS) {
          debug('stealing abandoned lock %s (owner pid %s)', lockPath, owner?.pid ?? 'unknown');
          stealLock(lockPath);
          continue;
        }
        if (ageMs > opts.staleMs) {
          debug('stealing stale lock %s', lockPath);
          stealLock(lockPath);
          continue;
        }
      } catch {
        // lock disappeared or another waiter won the steal; retry
      }
      if (Date.now() >= deadline) {
        if (!opts.failOpen) {
          throw new Error(
            `Timed out waiting for cache lock at ${lockPath}\n`
            + 'If no other varlock process is running this lock may be orphaned. '
            + 'Run `varlock cache clear --yes` or delete the path above.',
          );
        }
        // a lock problem must never become a resolution failure: the worst case
        // of proceeding is duplicated work, which is what the lock optimizes away
        debug('lock %s timed out, proceeding without it', lockPath);
        return await fn();
      }
      await sleep(opts.waitMs);
    }
  }

  let ownerWritten = false;
  try {
    fs.writeFileSync(
      path.join(lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, host: os.hostname(), token } satisfies LockOwner),
      { encoding: 'utf-8', mode: 0o600 },
    );
    ownerWritten = true;
    heldLocks.set(lockPath, token);
    registerLockCleanup();
  } catch {
    // without owner metadata the lock still works, it just can't be identified
  }

  // refresh mtime while held so long operations don't get their lock stolen
  const touchTimer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      // lock dir gone (stolen/removed) — nothing useful to do
    }
  }, Math.max(1_000, Math.floor(opts.staleMs / 3)));
  touchTimer.unref?.();

  const nestedHeld = new Set(outerHeld ?? []).add(lockPath);
  try {
    return await lockContext.run(nestedHeld, async () => fn());
  } finally {
    clearInterval(touchTimer);
    if (acquired) releaseLock(lockPath, ownerWritten ? token : undefined);
  }
}

export const MAX_CACHE_KEY_LENGTH = 2_048;
/** "forever" TTLs are stored as a concrete far-future expiry (~100 years) */
export const TTL_FOREVER_MS = 100 * 365.25 * 86_400_000;

type CacheEntry = {
  /** encrypted value */
  v: string;
  /** createdAt (unix ms) */
  c: number;
  /** expiresAt (unix ms) */
  e: number;
};

type CacheData = Record<string, CacheEntry>;

/** Pluggable per-value encryption for a CacheStore */
export type CacheValueCodec = {
  /** called before the first write — e.g. ensure a key exists / is valid */
  ensureReady(): Promise<void> | void;
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
};

export type CacheStoreLike = {
  get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined>;
  getOrSet(
    cacheKey: string,
    ttlMs: number,
    producer: () => Promise<any> | any,
  ): Promise<{ value: any; cachedAt: number; expiresAt: number; cacheHit: boolean } | undefined>;
  set(cacheKey: string, value: any, ttlMs: number): Promise<{ cachedAt: number; expiresAt: number } | undefined>;
  delete(cacheKey: string): Promise<void>;
  clearAll(): Promise<number>;
};

/** Compute a concrete expiry timestamp from a TTL (Infinity → far-future) */
export function expiryFromTtl(now: number, ttlMs: number): number {
  return Number.isFinite(ttlMs) ? now + ttlMs : now + TTL_FOREVER_MS;
}

/**
 * Group a cache key by its first two segments — e.g. `plugin:1password` or
 * `resolver:/path/to/.env`. Used for stats and the interactive cache browser.
 */
export function groupKeyPrefix(key: string): string {
  const firstColon = key.indexOf(':');
  if (firstColon < 0) return key;
  const secondColon = key.indexOf(':', firstColon + 1);
  return secondColon >= 0 ? key.slice(0, secondColon) : key.slice(0, firstColon);
}

/** Cache keys must not contain control characters (file format + terminal display safety) */
export function hasInvalidCacheKeyChars(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function assertValidCacheKey(key: string, label = 'cache key'): void {
  if (typeof key !== 'string') {
    throw new Error(`Invalid ${label}: must be a string`);
  }
  if (key.length === 0) {
    throw new Error(`Invalid ${label}: cannot be empty`);
  }
  if (key.length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(`Invalid ${label}: exceeds max length (${MAX_CACHE_KEY_LENGTH})`);
  }
  if (hasInvalidCacheKeyChars(key)) {
    throw new Error(`Invalid ${label}: contains control characters`);
  }
}


/**
 * JSON-file-based encrypted cache store.
 *
 * Stores one file per encryption key at `~/.config/varlock/cache/{keyId}.json`.
 * Each entry's value is individually encrypted via localEncrypt, wrapped in an
 * envelope that records its cache key so ciphertexts cannot be swapped between
 * entries within the file. Cache keys are structured strings like
 * `plugin:name:key` or `resolver:path:item:text`.
 *
 * Which key protects those entries follows the same routing as env values: the
 * identity key on backends that encrypt to one, the device key elsewhere.
 * `ensureEncryptionReady` puts whichever of those the run needs in place before
 * the first write, so a cache write never races key creation inside the lock.
 */
export class CacheStore {
  private filePath: string;
  private codec: CacheValueCodec;
  private static warnedWriteFailure = false;

  constructor(keyId: string = 'varlock-default', codec?: CacheValueCodec) {
    const cacheDir = path.join(getUserVarlockDir(), 'cache');
    this.filePath = path.join(cacheDir, `${keyId}.json`);
    this.codec = codec ?? {
      ensureReady: () => localEncrypt.ensureEncryptionReady(keyId),
      encrypt: (plaintext) => localEncrypt.encryptValue(plaintext, keyId),
      decrypt: (ciphertext) => localEncrypt.decryptValue(ciphertext, keyId),
    };
  }

  /**
   * Load and return a cached value, or undefined on miss/expired/error.
   * The value is JSON-parsed after decryption to preserve its original type (number, boolean, object, etc.).
   */
  async get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined> {
    assertValidCacheKey(cacheKey);
    const data = this.loadFile();
    const entry = data[cacheKey];
    if (!entry) return undefined;

    if (Date.now() > entry.e) {
      debug('cache expired for %s', cacheKey);
      await this.bestEffortDelete(cacheKey);
      return undefined;
    }

    try {
      const plaintext = await this.codec.decrypt(entry.v);
      const envelope = JSON.parse(plaintext);
      // the envelope binds the ciphertext to its key — a swapped/replayed entry decrypts
      // fine but fails this check
      if (!envelope || typeof envelope !== 'object' || envelope.k !== cacheKey) {
        debug('cache entry key mismatch for %s', cacheKey);
        await this.bestEffortDelete(cacheKey);
        return undefined;
      }
      return { value: envelope.v, cachedAt: entry.c, expiresAt: entry.e };
    } catch (err) {
      debug('cache decrypt failed for %s: %O', cacheKey, err);
      // corrupt or key mismatch — treat as cache miss
      await this.bestEffortDelete(cacheKey);
      return undefined;
    }
  }

  /**
   * Atomically get a cache entry or compute+store it once per key.
   *
   * Uses a per-key lock so concurrent callers (including across processes)
   * don't stampede the producer for the same cache key.
   */
  async getOrSet(
    cacheKey: string,
    ttlMs: number,
    producer: () => Promise<any> | any,
  ): Promise<{ value: any; cachedAt: number; expiresAt: number; cacheHit: boolean } | undefined> {
    assertValidCacheKey(cacheKey);

    const existing = await this.get(cacheKey);
    if (existing) {
      return { ...existing, cacheHit: true };
    }

    const keyHash = createHash('sha256').update(cacheKey).digest('hex');
    const lockPath = path.join(`${this.filePath}.keylocks`, `${keyHash}.lock`);

    return await withDirLock(lockPath, KEY_LOCK_OPTS, async () => {
      const latest = await this.get(cacheKey);
      if (latest) {
        return { ...latest, cacheHit: true };
      }

      const value = await producer();
      if (value === undefined) return undefined;

      const stored = await this.set(cacheKey, value, ttlMs);
      if (stored) {
        return { value, ...stored, cacheHit: false };
      }

      // cache write failed (e.g. encryption unavailable) — still return the computed value
      const now = Date.now();
      return {
        value, cachedAt: now, expiresAt: expiryFromTtl(now, ttlMs), cacheHit: false,
      };
    });
  }

  /**
   * Encrypt and store a value with a TTL.
   * The value is JSON-stringified before encryption to preserve its type on retrieval.
   * Returns the stored timestamps, or undefined if the write failed (caching is best-effort).
   */
  async set(cacheKey: string, value: any, ttlMs: number): Promise<{ cachedAt: number; expiresAt: number } | undefined> {
    assertValidCacheKey(cacheKey);
    const now = Date.now();
    const expiresAt = expiryFromTtl(now, ttlMs);

    try {
      await this.codec.ensureReady();
      const serialized = JSON.stringify({ k: cacheKey, v: value });
      const encrypted = await this.codec.encrypt(serialized);
      await this.withFileLock(() => {
        const data = this.pruneExpired(this.loadFile());
        data[cacheKey] = { v: encrypted, c: now, e: expiresAt };
        this.saveFile(data);
      });
      debug('cache set %s (ttl=%dms)', cacheKey, ttlMs);
      return { cachedAt: now, expiresAt };
    } catch (err) {
      debug('cache write failed for %s: %O', cacheKey, err);
      if (!CacheStore.warnedWriteFailure) {
        CacheStore.warnedWriteFailure = true;
        // eslint-disable-next-line no-console
        console.error('varlock cache write failed — values will not be cached this run (set DEBUG=varlock:cache for details)');
      }
      return undefined;
    }
  }

  /**
   * Delete a specific cache entry.
   */
  async delete(cacheKey: string): Promise<void> {
    assertValidCacheKey(cacheKey);
    await this.withFileLock(() => {
      const data = this.loadFile();
      if (cacheKey in data) {
        delete data[cacheKey];
        this.saveFile(data);
      }
    });
  }

  /**
   * Clear all cache entries. Returns the count of cleared entries.
   */
  async clearAll(): Promise<number> {
    return await this.withFileLock(() => {
      const data = this.loadFile();
      const count = Object.keys(data).length;
      if (count > 0) {
        this.saveFile({});
      }
      return count;
    });
  }

  /**
   * Clear entries matching a key prefix. Returns the count of cleared entries.
   * Example: `clearByPrefix("plugin:1password:")` clears all 1password plugin cache.
   */
  async clearByPrefix(prefix: string): Promise<number> {
    assertValidCacheKey(prefix, 'cache key prefix');
    return await this.withFileLock(() => {
      const data = this.loadFile();
      let count = 0;
      for (const key of Object.keys(data)) {
        if (key.startsWith(prefix)) {
          delete data[key];
          count++;
        }
      }
      if (count > 0) {
        this.saveFile(data);
      }
      return count;
    });
  }

  /**
   * Get cache statistics. `total` includes expired-but-not-yet-pruned entries.
   */
  getStats(): { total: number; expired: number; byPrefix: Record<string, number> } {
    const data = this.loadFile();
    const now = Date.now();
    let expired = 0;
    const byPrefix: Record<string, number> = {};

    for (const [key, entry] of Object.entries(data)) {
      if (now > entry.e) {
        expired++;
        continue;
      }
      byPrefix[groupKeyPrefix(key)] = (byPrefix[groupKeyPrefix(key)] || 0) + 1;
    }

    return {
      total: Object.keys(data).length,
      expired,
      byPrefix,
    };
  }

  /**
   * List all non-expired entries with their metadata (for interactive browsing).
   * Values are NOT decrypted — only keys and timestamps are returned.
   */
  listEntries(): Array<{ key: string; cachedAt: number; expiresAt: number }> {
    const data = this.loadFile();
    const now = Date.now();
    return Object.entries(data)
      .filter(([, entry]) => now <= entry.e)
      .map(([key, entry]) => ({ key, cachedAt: entry.c, expiresAt: entry.e }));
  }

  /**
   * Get the file path for this cache store (for display purposes).
   */
  getFilePath(): string {
    return this.filePath;
  }

  /** Directory holding this store's per-key lock dirs. */
  getKeyLocksPath(): string {
    return `${this.filePath}.keylocks`;
  }

  /**
   * Remove this store's lock dirs.
   *
   * Locks are normally self-healing (an abandoned lock is detected via owner
   * liveness), but clearing them explicitly is the escape hatch when a lock
   * survives that check, e.g. one left on a different machine via a synced
   * home directory, where pid liveness can't be evaluated.
   */
  clearLocks(): void {
    for (const target of [this.getKeyLocksPath(), `${this.filePath}.lock`]) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        debug('failed to clear locks at %s: %O', target, err);
      }
    }
  }

  // -- internal --

  private loadFile(): CacheData {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as CacheData;
    } catch (err) {
      debug('cache file load failed: %O', err);
      return {};
    }
  }

  /** Throws on failure — callers decide whether a failed write is fatal. */
  private saveFile(data: CacheData): void {
    // atomic write: exclusively create a temp file then rename over the target
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    // explicit chmod in case rename preserved an existing file's mode
    fs.chmodSync(this.filePath, 0o600);
  }

  private pruneExpired(data: CacheData): CacheData {
    const now = Date.now();
    for (const key of Object.keys(data)) {
      if (now > data[key].e) delete data[key];
    }
    return data;
  }

  /** Delete used for internal housekeeping (expired/corrupt entries) — must not break reads */
  private async bestEffortDelete(cacheKey: string): Promise<void> {
    try {
      await this.delete(cacheKey);
    } catch (err) {
      debug('cache cleanup delete failed for %s: %O', cacheKey, err);
    }
  }

  private async withFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
    this.ensureCacheDir();
    return await withDirLock(`${this.filePath}.lock`, FILE_LOCK_OPTS, fn);
  }

  private ensureCacheDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      // 0700 — cache keys include file paths and resolver source text,
      // which can leak secret topology even though values are encrypted
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      // re-enforce on every use in case the dir pre-existed with a looser mode
      fs.chmodSync(dir, 0o700);
    } catch {
      // best-effort hardening only
    }
  }
}
