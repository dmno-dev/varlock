import { expiryFromTtl, type CacheStoreLike } from './cache-store';

/**
 * No-op store used when caching is unavailable (e.g. `--skip-cache`,
 * `@cache=disabled`). Lets plugin code call `plugin.cache.*` unconditionally —
 * every read misses and writes are discarded, so producers always run.
 */
export class NoopCacheStore implements CacheStoreLike {
  async get(): Promise<undefined> {
    return undefined;
  }

  async getOrSet(
    cacheKey: string,
    ttlMs: number,
    producer: () => Promise<any> | any,
  ): Promise<{ value: any; cachedAt: number; expiresAt: number; cacheHit: boolean } | undefined> {
    const value = await producer();
    if (value === undefined) return undefined;
    const now = Date.now();
    return {
      value, cachedAt: now, expiresAt: expiryFromTtl(now, ttlMs), cacheHit: false,
    };
  }

  async set(): Promise<undefined> {
    return undefined;
  }

  async delete(): Promise<void> {
    // nothing stored, nothing to delete
  }

  async clearAll(): Promise<number> {
    return 0;
  }
}
