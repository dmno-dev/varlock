import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getUserVarlockDir } from '../user-config-dir';
import * as localEncrypt from '../local-encrypt';
import { createDebug } from '../debug';

const debug = createDebug('varlock:cache');

const FILE_LOCK_OPTS = { waitMs: 25, timeoutMs: 5_000, staleMs: 30_000 };
const KEY_LOCK_OPTS = { waitMs: 50, timeoutMs: 5 * 60_000, staleMs: 10 * 60_000 };

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

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Cross-process mutual exclusion via atomic `mkdir` of a lock directory.
 *
 * Stale locks are stolen via an atomic rename (so two waiters cannot both
 * "remove and acquire"), and held locks have their mtime refreshed
 * periodically so a long-running holder is not treated as stale.
 */
async function withDirLock<T>(
  lockPath: string,
  opts: { waitMs: number; timeoutMs: number; staleMs: number },
  fn: () => Promise<T> | T,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
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
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > opts.staleMs) {
          // steal stale lock atomically — only one waiter can win the rename
          const graveyard = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
          fs.renameSync(lockPath, graveyard);
          fs.rmSync(graveyard, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock disappeared or another waiter won the steal; retry
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for cache lock at ${lockPath}`);
      }
      await sleep(opts.waitMs);
    }
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

  try {
    return await fn();
  } finally {
    clearInterval(touchTimer);
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // lock cleanup failure is non-fatal
    }
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
 */
export class CacheStore {
  private filePath: string;
  private codec: CacheValueCodec;
  private static warnedWriteFailure = false;

  /**
   * Local encryption key id backing this store, or undefined when a custom
   * codec is supplied (e.g. the env-key store). Lets the graph swap the
   * auto-policy store when `@defaultLocalKey` selects a different key.
   */
  readonly localEncryptKeyId?: string;

  constructor(keyId: string = 'varlock-default', codec?: CacheValueCodec) {
    const cacheDir = path.join(getUserVarlockDir(), 'cache');
    this.filePath = path.join(cacheDir, `${keyId}.json`);
    if (!codec) this.localEncryptKeyId = keyId;
    this.codec = codec ?? {
      ensureReady: () => localEncrypt.ensureKey(keyId),
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
