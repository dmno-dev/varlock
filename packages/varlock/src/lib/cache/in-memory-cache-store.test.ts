import {
  describe, it, expect, vi,
} from 'vitest';
import { InMemoryCacheStore } from './in-memory-cache-store';
import { NoopCacheStore } from './noop-cache-store';

describe('InMemoryCacheStore', () => {
  it('stores and retrieves values', async () => {
    const store = new InMemoryCacheStore();
    await store.set('plugin:test:k', 'hello', 60_000);
    const result = await store.get('plugin:test:k');
    expect(result?.value).toBe('hello');
  });

  it('returns undefined for missing keys', async () => {
    const store = new InMemoryCacheStore();
    expect(await store.get('plugin:test:missing')).toBeUndefined();
  });

  it('expires entries', async () => {
    const store = new InMemoryCacheStore();
    await store.set('plugin:test:exp', 'v', 1);
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    expect(await store.get('plugin:test:exp')).toBeUndefined();
  });

  it('set returns the stored timestamps', async () => {
    const store = new InMemoryCacheStore();
    const before = Date.now();
    const stored = await store.set('plugin:test:ts', 'v', 60_000);
    expect(stored.cachedAt).toBeGreaterThanOrEqual(before);
    expect(stored.expiresAt).toBe(stored.cachedAt + 60_000);
  });

  it('treats Infinity TTL as far-future expiry', async () => {
    const store = new InMemoryCacheStore();
    const stored = await store.set('plugin:test:forever', 'v', Infinity);
    expect(Number.isFinite(stored.expiresAt)).toBe(true);
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 50 * 365 * 86_400_000);
  });

  describe('getOrSet', () => {
    it('deduplicates concurrent producers (in-flight promise)', async () => {
      const store = new InMemoryCacheStore();
      const producer = vi.fn(async () => {
        await new Promise<void>((r) => {
          setTimeout(r, 20);
        });
        return 'shared';
      });
      const [a, b] = await Promise.all([
        store.getOrSet('k', 60_000, producer),
        store.getOrSet('k', 60_000, producer),
      ]);
      expect(producer).toHaveBeenCalledTimes(1);
      expect(a?.value).toBe('shared');
      expect(b?.value).toBe('shared');
    });

    it('propagates producer errors and allows retry', async () => {
      const store = new InMemoryCacheStore();
      await expect(store.getOrSet('k', 60_000, () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
      const result = await store.getOrSet('k', 60_000, () => 'recovered');
      expect(result?.value).toBe('recovered');
    });

    it('does not store undefined producer results', async () => {
      const store = new InMemoryCacheStore();
      const result = await store.getOrSet('k', 60_000, () => undefined);
      expect(result).toBeUndefined();
      expect(await store.get('k')).toBeUndefined();
    });
  });

  it('delete and clearAll work', async () => {
    const store = new InMemoryCacheStore();
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.clearAll()).toBe(1);
    expect(await store.get('b')).toBeUndefined();
  });
});

describe('NoopCacheStore', () => {
  it('always misses and never stores', async () => {
    const store = new NoopCacheStore();
    await store.set();
    expect(await store.get()).toBeUndefined();

    const producer = vi.fn(() => 'computed');
    const result = await store.getOrSet('k', 60_000, producer);
    expect(result?.value).toBe('computed');
    expect(result?.cacheHit).toBe(false);

    // producer runs every time — nothing was stored
    await store.getOrSet('k', 60_000, producer);
    expect(producer).toHaveBeenCalledTimes(2);
    expect(await store.clearAll()).toBe(0);
  });
});
