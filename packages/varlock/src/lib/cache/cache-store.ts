import fs from 'node:fs';
import path from 'node:path';
import { getUserVarlockDir } from '../user-config-dir';
import * as localEncrypt from '../local-encrypt';
import { createDebug } from '../debug';

const debug = createDebug('varlock:cache');

type CacheEntry = {
  /** encrypted value */
  v: string;
  /** createdAt (unix ms) */
  c: number;
  /** expiresAt (unix ms) */
  e: number;
};

type CacheData = Record<string, CacheEntry>;

/**
 * JSON-file-based encrypted cache store.
 *
 * Stores one file per encryption key at `~/.config/varlock/cache/{keyId}.json`.
 * Each entry's value is individually encrypted via localEncrypt.
 * Cache keys are structured strings like `plugin:name:key` or `resolver:path:item:text`.
 */
export class CacheStore {
  private filePath: string;
  /** In-memory cache — source of truth during a session to avoid concurrent read/write races */
  private memCache?: CacheData;

  constructor(private keyId: string = 'varlock-default') {
    const cacheDir = path.join(getUserVarlockDir(), 'cache');
    this.filePath = path.join(cacheDir, `${keyId}.json`);
  }

  /**
   * Load and return a cached value, or undefined on miss/expired/error.
   * The value is JSON-parsed after decryption to preserve its original type (number, boolean, object, etc.).
   */
  async get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined> {
    const data = this.loadFile();
    const entry = data[cacheKey];
    if (!entry) return undefined;

    // check expiry
    if (Date.now() > entry.e) {
      debug('cache expired for %s', cacheKey);
      delete data[cacheKey];
      this.saveFile(data);
      return undefined;
    }

    try {
      const plaintext = await localEncrypt.decryptValue(entry.v, this.keyId);
      return { value: JSON.parse(plaintext), cachedAt: entry.c, expiresAt: entry.e };
    } catch (err) {
      debug('cache decrypt failed for %s: %O', cacheKey, err);
      // corrupt or key mismatch — treat as cache miss
      delete data[cacheKey];
      this.saveFile(data);
      return undefined;
    }
  }

  /**
   * Encrypt and store a value with a TTL.
   * The value is JSON-stringified before encryption to preserve its type on retrieval.
   */
  async set(cacheKey: string, value: any, ttlMs: number): Promise<void> {
    const data = this.loadFile();
    const now = Date.now();

    try {
      const serialized = JSON.stringify(value);
      const encrypted = await localEncrypt.encryptValue(serialized, this.keyId);
      data[cacheKey] = {
        v: encrypted,
        c: now,
        // Infinity TTL → use a far-future expiry (~100 years)
        e: Number.isFinite(ttlMs) ? now + ttlMs : now + 100 * 365.25 * 86_400_000,
      };
      this.saveFile(data);
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
    const data = this.loadFile();
    if (cacheKey in data) {
      delete data[cacheKey];
      this.saveFile(data);
    }
  }

  /**
   * Clear all cache entries. Returns the count of cleared entries.
   */
  clearAll(): number {
    const data = this.loadFile();
    const count = Object.keys(data).length;
    if (count > 0) {
      this.memCache = {};
      this.saveFile(this.memCache);
    }
    return count;
  }

  /**
   * Clear entries matching a key prefix. Returns the count of cleared entries.
   * Example: `clearByPrefix("plugin:1password:")` clears all 1password plugin cache.
   */
  clearByPrefix(prefix: string): number {
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
    if (this.memCache) return this.memCache;
    try {
      if (!fs.existsSync(this.filePath)) {
        this.memCache = {};
        return this.memCache;
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as CacheData;

      // cleanup expired entries while we're here
      this.memCache = this.cleanup(data);
      return this.memCache;
    } catch (err) {
      debug('cache file load failed: %O', err);
      this.memCache = {};
      return this.memCache;
    }
  }

  private saveFile(data: CacheData): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // atomic write: write to temp file then rename
      const tmpPath = `${this.filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      debug('cache file save failed: %O', err);
    }
  }

  private cleanup(data: CacheData): CacheData {
    const now = Date.now();
    let dirty = false;
    for (const key of Object.keys(data)) {
      if (now > data[key].e) {
        delete data[key];
        dirty = true;
      }
    }
    // write back cleaned data if anything was removed
    if (dirty) {
      this.saveFile(data);
    }
    return data;
  }
}
