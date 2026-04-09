import { AsyncLocalStorage } from 'node:async_hooks';
import type { CacheStore } from '../../lib/cache/cache-store';
import type { ConfigItem } from './config-item';

export type CacheHitInfo = {
  cacheKey: string;
  cachedAt: number;
};

export type ResolutionContextData = {
  cacheStore?: CacheStore;
  skipCache: boolean;
  clearCache: boolean;
  /** Cache hits recorded during resolution of the current item */
  cacheHits: Array<CacheHitInfo>;
  /** The ConfigItem currently being resolved */
  currentItem: ConfigItem;
};

const resolutionContextStorage = new AsyncLocalStorage<ResolutionContextData>();

/**
 * Run a function within a resolution context.
 * Used in resolveEnvValues() to provide per-item context to resolvers via ALS.
 */
export function runWithResolutionContext<T>(ctx: ResolutionContextData, fn: () => T): T {
  return resolutionContextStorage.run(ctx, fn);
}

/**
 * Get the current resolution context, if any.
 * Called by resolvers (e.g., cache()) to access the cache store and current item.
 */
export function getResolutionContext(): ResolutionContextData | undefined {
  return resolutionContextStorage.getStore();
}
