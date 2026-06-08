import fs from 'node:fs';
import path from 'node:path';
import { getUserVarlockDir } from '../user-config-dir';
import * as localEncrypt from '../local-encrypt';
import { createDebug } from '../debug';

const debug = createDebug('varlock:cache');
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const MAX_CACHE_KEY_LENGTH = 2_048;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

type CacheEntry = {
  /** encrypted value */
  v: string;
  /** createdAt (unix ms) */
  c: number;
  /** expiresAt (unix ms) */
  e: number;
};

type CacheData = Record<string, CacheEntry>;

export type CacheStoreLike = {
  get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined>;
  set(cacheKey: string, value: any, ttlMs: number): Promise<void>;
  delete(cacheKey: string): void;
  clearAll(): number;
  clearByPrefix(prefix: string): number;
  getStats(): { total: number; expired: number; byPrefix: Record<string, number> };
  listEntries(): Array<{ key: string; cachedAt: number; expiresAt: number }>;
  getFilePath(): string;
};

/**
 * JSON-file-based encrypted cache store.
 *
 * Stores one file per encryption key at `~/.config/varlock/cache/{keyId}.json`.
 * Each entry's value is individually encrypted via localEncrypt.
 * Cache keys are structured strings like `plugin:name:key` or `resolver:path:item:text`.
 */
export class CacheStore {
  private filePath: string;

  constructor(private keyId: string = 'varlock-default') {
    const cacheDir = path.join(getUserVarlockDir(), 'cache');
    this.filePath = path.join(cacheDir, `${keyId}.json`);
  }

  /**
   * Load and return a cached value, or undefined on miss/expired/error.
   * The value is JSON-parsed after decryption to preserve its original type (number, boolean, object, etc.).
   */
  async get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined> {
    this.assertValidCacheKey(cacheKey);
    const data = this.loadFile();
    const entry = data[cacheKey];
    if (!entry) return undefined;

    // check expiry
    if (Date.now() > entry.e) {
      debug('cache expired for %s', cacheKey);
      this.withWriteLock(() => {
        const latestData = this.loadFile();
        delete latestData[cacheKey];
        this.saveFile(latestData);
      });
      return undefined;
    }

    try {
      const plaintext = await localEncrypt.decryptValue(entry.v, this.keyId);
      return { value: JSON.parse(plaintext), cachedAt: entry.c, expiresAt: entry.e };
    } catch (err) {
      debug('cache decrypt failed for %s: %O', cacheKey, err);
      // corrupt or key mismatch — treat as cache miss
      this.withWriteLock(() => {
        const latestData = this.loadFile();
        delete latestData[cacheKey];
        this.saveFile(latestData);
      });
      return undefined;
    }
  }

  /**
   * Encrypt and store a value with a TTL.
   * The value is JSON-stringified before encryption to preserve its type on retrieval.
   */
  async set(cacheKey: string, value: any, ttlMs: number): Promise<void> {
    this.assertValidCacheKey(cacheKey);
    const now = Date.now();

    try {
      await localEncrypt.ensureKey(this.keyId);
      const serialized = JSON.stringify(value);
      const encrypted = await localEncrypt.encryptValue(serialized, this.keyId);
      this.withWriteLock(() => {
        const data = this.loadFile();
        data[cacheKey] = {
          v: encrypted,
          c: now,
          // Infinity TTL → use a far-future expiry (~100 years)
          e: Number.isFinite(ttlMs) ? now + ttlMs : now + 100 * 365.25 * 86_400_000,
        };
        this.saveFile(data);
      });
      debug('cache set %s (ttl=%dms)', cacheKey, ttlMs);
    } catch (err) {
      debug('cache encrypt failed for %s: %O', cacheKey, err);
      // encryption failure is non-fatal — just skip caching
    }
  }

  /**
   * Delete a specific cache entry.
   */
  delete(cacheKey: string): void {
    this.assertValidCacheKey(cacheKey);
    this.withWriteLock(() => {
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
  clearAll(): number {
    return this.withWriteLock(() => {
      const data = this.loadFile();
      const count = Object.keys(data).length;
      if (count > 0) {
        for (const key of Object.keys(data)) delete data[key];
        this.saveFile(data);
      }
      return count;
    });
  }

  /**
   * Clear entries matching a key prefix. Returns the count of cleared entries.
   * Example: `clearByPrefix("plugin:1password:")` clears all 1password plugin cache.
   */
  clearByPrefix(prefix: string): number {
    this.assertValidCacheKey(prefix, 'cache key prefix');
    return this.withWriteLock(() => {
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
   * Get cache statistics.
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
      // group by first two segments: "plugin:name" or "resolver"
      const firstColon = key.indexOf(':');
      const secondColon = firstColon >= 0 ? key.indexOf(':', firstColon + 1) : -1;
      const prefix = secondColon >= 0 ? key.slice(0, secondColon) : key.slice(0, firstColon);
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
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
      return this.cleanup(JSON.parse(raw) as CacheData);
    } catch (err) {
      debug('cache file load failed: %O', err);
      return {};
    }
  }

  private saveFile(data: CacheData): void {
    try {
      // atomic write: write to temp file then rename
      const tmpPath = `${this.filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
      // explicit chmod in case rename preserved an existing file's mode
      fs.chmodSync(this.filePath, 0o600);
    } catch (err) {
      debug('cache file save failed: %O', err);
    }
  }

  private cleanup(data: CacheData): CacheData {
    const now = Date.now();
    for (const key of Object.keys(data)) {
      if (now > data[key].e) delete data[key];
    }
    return data;
  }

  private withWriteLock<T>(fn: () => T): T {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      // 0700 — cache keys include file paths and resolver source text,
      // which can leak secret topology even though values are encrypted
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        break;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') {
          throw err;
        }
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock file disappeared between checks; retry
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for cache lock at ${lockPath}`);
        }
        Atomics.wait(lockWaitBuffer, 0, 0, LOCK_WAIT_MS);
      }
    }

    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // lock cleanup failure is non-fatal
      }
    }
  }

  private assertValidCacheKey(key: string, label = 'cache key'): void {
    if (typeof key !== 'string') {
      throw new Error(`Invalid ${label}: must be a string`);
    }
    if (key.length === 0) {
      throw new Error(`Invalid ${label}: cannot be empty`);
    }
    if (key.length > MAX_CACHE_KEY_LENGTH) {
      throw new Error(`Invalid ${label}: exceeds max length (${MAX_CACHE_KEY_LENGTH})`);
    }
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      if (code < 32 || code === 127) {
        throw new Error(`Invalid ${label}: contains control characters`);
      }
    }
  }
}
