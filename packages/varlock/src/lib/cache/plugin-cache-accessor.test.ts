import {
  describe, it, expect, vi,
} from 'vitest';
import { PluginCacheAccessor } from './plugin-cache-accessor';
import { InMemoryCacheStore } from './in-memory-cache-store';
import { resolveCacheTtl } from './resolve-cache-ttl';

describe('PluginCacheAccessor', () => {
  it('prefixes keys with plugin:{name}:', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    await accessor.set('vault/item', 'v', '1h');
    expect((await store.get('plugin:my-plugin:vault/item'))?.value).toBe('v');
    expect(await accessor.get('vault/item')).toBe('v');
  });

  it('parses string TTLs including "forever"', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    await accessor.set('k', 'v', 'forever');
    const entry = await store.get('plugin:my-plugin:k');
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 50 * 365 * 86_400_000);
  });

  it('getOrSet runs producer once and returns cached value after', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    const producer = vi.fn(() => 'fresh');
    expect(await accessor.getOrSet('k', '1h', producer)).toBe('fresh');
    expect(await accessor.getOrSet('k', '1h', producer)).toBe('fresh');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('delete removes only the namespaced entry', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    await accessor.set('k', 'v', '1h');
    await store.set('plugin:other:k', 'other', 60_000);
    accessor.delete('k');
    expect(await accessor.get('k')).toBeUndefined();
    expect((await store.get('plugin:other:k'))?.value).toBe('other');
  });
});

describe('PluginCacheAccessor getOrSet with a TTL callback', () => {
  it('derives the TTL from the produced value', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    // the kind of value whose lifetime the source decides, not the caller
    const session = { token: 'abc', expiresAt: Date.now() + 3600_000 };

    const value = await accessor.getOrSet('session', (v: any) => v.expiresAt - Date.now(), () => session);
    expect(value).toEqual(session);

    const entry = await store.get('plugin:my-plugin:session');
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(entry!.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
  });

  it('accepts a duration string from the callback', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    await accessor.getOrSet('k', () => '1h', () => 'v');
    const entry = await store.get('plugin:my-plugin:k');
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('does not call the callback when the value came from cache', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    const ttlFn = vi.fn(() => 3600_000);
    await accessor.getOrSet('k', ttlFn, () => 'v');
    await accessor.getOrSet('k', ttlFn, () => 'v');
    expect(ttlFn).toHaveBeenCalledTimes(1);
  });

  it('skips caching when the callback returns a non-positive TTL, still returning the value', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    // e.g. a session that is already too close to expiry to be worth sharing
    expect(await accessor.getOrSet('k', () => -1, () => 'expiring')).toBe('expiring');
    expect(await store.get('plugin:my-plugin:k')).toBeUndefined();
  });

  it('hands the produced value to everyone coalesced onto one producer', async () => {
    const store = new InMemoryCacheStore();
    const accessor = new PluginCacheAccessor('my-plugin', store);
    const producer = vi.fn(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return { token: 'once' };
    });

    // concurrent callers must share the single result - if a waiter got undefined it
    // would go off and produce again, which for a single-use credential means failure
    const results = await Promise.all([
      accessor.getOrSet('k', () => 3600_000, producer),
      accessor.getOrSet('k', () => 3600_000, producer),
      accessor.getOrSet('k', () => 3600_000, producer),
    ]);
    expect(producer).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual({ token: 'once' });
  });
});

describe('resolveCacheTtl', () => {
  const resolverFor = (value: any) => ({ resolve: async () => value });

  it('returns undefined when no resolver is set', async () => {
    expect(await resolveCacheTtl(undefined)).toBeUndefined();
  });

  it('falsy values disable caching', async () => {
    expect(await resolveCacheTtl(resolverFor(false))).toBeUndefined();
    expect(await resolveCacheTtl(resolverFor(undefined))).toBeUndefined();
    expect(await resolveCacheTtl(resolverFor(''))).toBeUndefined();
    expect(await resolveCacheTtl(resolverFor(null))).toBeUndefined();
  });

  it('passes through valid TTLs', async () => {
    expect(await resolveCacheTtl(resolverFor('1h'))).toBe('1h');
    expect(await resolveCacheTtl(resolverFor('forever'))).toBe('forever');
    expect(await resolveCacheTtl(resolverFor(5000))).toBe(5000);
  });

  it('throws on invalid TTL formats', async () => {
    await expect(resolveCacheTtl(resolverFor('not-a-duration'))).rejects.toThrow();
    await expect(resolveCacheTtl(resolverFor(0))).rejects.toThrow(/ambiguous/);
    await expect(resolveCacheTtl(resolverFor({ bad: true }))).rejects.toThrow(/invalid type/);
  });
});
