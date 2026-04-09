import type { CacheStore } from './cache-store';
import { parseTtl } from './ttl-parser';

/**
 * Scoped cache accessor for plugin authors.
 *
 * All keys are automatically prefixed with `plugin:{pluginName}:` so plugins
 * cannot collide with each other's cache entries.
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
    private cacheStore: CacheStore,
  ) {}

  private buildKey(key: string): string {
    return `plugin:${this.pluginName}:${key}`;
  }

  async get(key: string): Promise<any | undefined> {
    const result = await this.cacheStore.get(this.buildKey(key));
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
