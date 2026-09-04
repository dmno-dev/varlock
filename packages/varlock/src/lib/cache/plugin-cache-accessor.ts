import type { CacheStoreLike, CacheTtlMs } from './cache-store';
import { parseTtl } from './ttl-parser';

/**
 * A TTL for {@link PluginCacheAccessor.getOrSet}: a duration string, a number of ms, or
 * a callback given the produced value, for lifetimes only the source can tell you.
 */
export type PluginCacheTtl = string | number | ((value: any) => string | number);

function normalizeTtl(ttl: string | number): number {
  return typeof ttl === 'string' ? parseTtl(ttl) : ttl;
}

/**
 * Scoped cache accessor for plugin authors.
 *
 * All keys are automatically prefixed with `plugin:{pluginName}:` so plugins
 * cannot collide with each other's cache entries.
 *
 * Cache hits are automatically recorded on the current resolution context
 * (if any) so they show up in `varlock load` and `varlock explain` output.
 *
 * Usage in a plugin:
 * ```ts
 * const cached = await plugin.cache.get('vault/MyVault/item/DBCreds');
 * if (!cached) {
 *   const value = await fetchFromAPI();
 *   await plugin.cache.set('vault/MyVault/item/DBCreds', value, '1h');
 * }
 * ```
 */
export class PluginCacheAccessor {
  constructor(
    private pluginName: string,
    private cacheStore: CacheStoreLike,
  ) {}

  private buildKey(key: string): string {
    return `plugin:${this.pluginName}:${key}`;
  }

  private async recordCacheHit(cacheKey: string, cachedAt: number, expiresAt: number): Promise<void> {
    try {
      const { getResolutionContext } = await import('../../env-graph/lib/resolution-context');
      const ctx = getResolutionContext();
      ctx?.cacheHits.push({ cacheKey, cachedAt, expiresAt });
    } catch {
      // resolution context not available — that's fine
    }
  }

  async get(key: string): Promise<any | undefined> {
    const cacheKey = this.buildKey(key);
    const result = await this.cacheStore.get(cacheKey);
    if (result) {
      await this.recordCacheHit(cacheKey, result.cachedAt, result.expiresAt);
    }
    return result?.value;
  }

  /**
   * Read `key`, or run `producer` and store what it returns.
   *
   * `ttl` may be a callback receiving the produced value, for values whose lifetime the
   * source decides rather than the caller (an STS session, an OAuth token, a lease).
   * Return zero or less from it to skip caching that particular value.
   *
   * On a store that supports it this holds a cross-process lock around the producer, so
   * concurrent varlock runs share one result instead of each doing the work. That sharing
   * covers persisted results only: when the write is skipped (non-positive TTL) or fails,
   * later processes run the producer themselves. Callers guarding single-use work (a
   * one-time code, a metered call) must return a positive TTL for anything others reuse.
   */
  async getOrSet(
    key: string,
    ttl: PluginCacheTtl,
    producer: () => Promise<any> | any,
  ): Promise<any | undefined> {
    const cacheKey = this.buildKey(key);
    const ttlMs: CacheTtlMs = typeof ttl === 'function'
      ? (value: any) => normalizeTtl(ttl(value))
      : normalizeTtl(ttl);
    const result = await this.cacheStore.getOrSet(cacheKey, ttlMs, producer);
    if (result?.cacheHit) {
      await this.recordCacheHit(cacheKey, result.cachedAt, result.expiresAt);
    }
    return result?.value;
  }

  async set(key: string, value: any, ttl: string | number): Promise<void> {
    const ttlMs = typeof ttl === 'string' ? parseTtl(ttl) : ttl;
    await this.cacheStore.set(this.buildKey(key), value, ttlMs);
  }

  delete(key: string): void {
    this.cacheStore.delete(this.buildKey(key));
  }
}
