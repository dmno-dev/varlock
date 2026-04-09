/**
 * Tests for the cache() resolver function.
 *
 * Tests schema validation, resolver wiring, and actual caching behavior
 * using a random resolver and mock cache store.
 */

import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { Resolver } from '../lib/resolver';
import { CacheStore } from '../../lib/cache';

let tempDir: string;

// mock localEncrypt to avoid needing real encryption keys
vi.mock('../../lib/local-encrypt', () => ({
  encryptValue: vi.fn(async (value: string) => `encrypted:${value}`),
  decryptValue: vi.fn(async (value: string) => value.replace('encrypted:', '')),
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  ensureKey: vi.fn(async () => {}),
  keyExists: vi.fn(() => true),
}));

// mock user config dir to use temp directory
vi.mock('../../lib/user-config-dir', () => ({
  getUserVarlockDir: () => tempDir,
}));

// track call counts via mutable object (closures in static def capture the reference)
const calls = { random: 0, counter: 0 };

// random resolver — returns a different value each time
class RandomResolver extends Resolver {
  static def = {
    name: 'random',
    label: 'random',
    icon: '',
    async resolve() {
      calls.random++;
      return `random-${Math.random().toString(36).slice(2)}`;
    },
  };
}

// counter resolver — increments each call
class CounterResolver extends Resolver {
  static def = {
    name: 'counter',
    label: 'counter',
    icon: '',
    async resolve() { return ++calls.counter; },
  };
}

async function loadAndResolve(envContent: string, opts?: {
  cacheStore?: CacheStore;
  clearCache?: boolean;
  skipCache?: boolean;
}) {
  const g = new EnvGraph();
  g.registerResolver(RandomResolver);
  g.registerResolver(CounterResolver);
  if (opts?.cacheStore) g._cacheStore = opts.cacheStore;
  if (opts?.clearCache) g._clearCacheMode = true;
  if (opts?.skipCache) g._skipCacheMode = true;
  const source = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envContent}
    `,
  });
  await g.setRootDataSource(source);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

function createTestCacheStore() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-cache-resolver-test-'));
  return new CacheStore();
}

beforeEach(() => {
  calls.random = 0;
  calls.counter = 0;
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('cache() resolver', () => {
  describe('schema validation', () => {
    it('accepts cache() without ttl (defaults to forever)', async () => {
      const g = await loadAndResolve('A=cache(random())');
      const item = g.configSchema.A;
      expect(item.errors.length).toBe(0);
      expect(item.resolvedValue).toBeDefined();
    });

    it('rejects cache() with invalid ttl format', async () => {
      const g = await loadAndResolve('A=cache("static", ttl="invalid")');
      const item = g.configSchema.A;
      expect(item.errors.length).toBeGreaterThan(0);
    });

    it('accepts cache() with valid ttl', async () => {
      const g = await loadAndResolve('A=cache(random(), ttl="1h")');
      const item = g.configSchema.A;
      expect(item.resolvedValue).toBeDefined();
      expect(item.errors.length).toBe(0);
    });

    it('warns when wrapping a static value', async () => {
      const g = await loadAndResolve('A=cache("static-val", ttl="1h")');
      const item = g.configSchema.A;
      // should still resolve (warning, not error)
      expect(item.resolvedValue).toBe('static-val');
      // the warning is on the resolver's schema errors
      const resolverWarnings = item.resolverSchemaErrors.filter((e) => e.isWarning);
      expect(resolverWarnings.length).toBeGreaterThan(0);
      expect(resolverWarnings.some((e) => e.message.includes('static value'))).toBe(true);
    });

    it('accepts cache() with ttl=0 (forever)', async () => {
      const g = await loadAndResolve('A=cache(random(), ttl=0)');
      const item = g.configSchema.A;
      expect(item.resolvedValue).toBeDefined();
      expect(item.errors.length).toBe(0);
    });
  });

  describe('resolution without cache store', () => {
    it('resolves wrapped static value', async () => {
      const g = await loadAndResolve('A=cache("world", ttl="30m")');
      expect(g.configSchema.A.resolvedValue).toBe('world');
    });

    it('resolves wrapped function', async () => {
      const g = await loadAndResolve('A=cache(counter(), ttl="1h")');
      // counter returns a number but default type is string, so it gets coerced
      expect(g.configSchema.A.resolvedValue).toBe('1');
    });

    it('works with fallback wrapping cache', async () => {
      const g = await loadAndResolve('A=fallback(cache("first", ttl="1h"), "second")');
      expect(g.configSchema.A.resolvedValue).toBe('first');
    });
  });

  describe('caching behavior with cache store', () => {
    it('caches a value and returns it on second resolve', async () => {
      const store = createTestCacheStore();

      // first resolve — cache miss, resolver runs
      const g1 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });
      const firstValue = g1.configSchema.A.resolvedValue;
      expect(firstValue).toBeDefined();
      expect(calls.random).toBe(1);
      expect(g1.configSchema.A.isCacheHit).toBe(false);

      // second resolve — cache hit, resolver should NOT run again
      const g2 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });
      expect(g2.configSchema.A.resolvedValue).toBe(firstValue);
      // random resolver was only called once total (from first resolve)
      expect(calls.random).toBe(1);
      expect(g2.configSchema.A.isCacheHit).toBe(true);
      expect(g2.configSchema.A._cacheHits.length).toBe(1);
    });

    it('cache invalidates when resolver text changes', async () => {
      const store = createTestCacheStore();

      const g1 = await loadAndResolve('A=cache("value-1", ttl="1h")', { cacheStore: store });
      expect(g1.configSchema.A.resolvedValue).toBe('value-1');

      // change the wrapped resolver — should NOT get cached value
      const g2 = await loadAndResolve('A=cache("value-2", ttl="1h")', { cacheStore: store });
      expect(g2.configSchema.A.resolvedValue).toBe('value-2');
      expect(g2.configSchema.A.isCacheHit).toBe(false);
    });

    it('--clear-cache skips reading but rewrites', async () => {
      const store = createTestCacheStore();

      // populate cache
      const g1 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });
      const firstValue = g1.configSchema.A.resolvedValue;

      // clear-cache: should resolve fresh (not return cached value)
      const g2 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store, clearCache: true });
      expect(g2.configSchema.A.resolvedValue).not.toBe(firstValue);
      expect(calls.random).toBe(2);

      // third resolve without clear: should get the new cached value
      const g3 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });
      expect(g3.configSchema.A.resolvedValue).toBe(g2.configSchema.A.resolvedValue);
      expect(calls.random).toBe(2); // not called again
    });

    it('--skip-cache bypasses cache entirely', async () => {
      const store = createTestCacheStore();

      // populate cache
      await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });

      // skip-cache: should resolve fresh and NOT write to cache
      const g2 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store, skipCache: true });
      expect(calls.random).toBe(2);
      expect(g2.configSchema.A.isCacheHit).toBe(false);

      // third resolve without skip: should still get original cached value (skip didn't overwrite)
      const g3 = await loadAndResolve('A=cache(random(), ttl="1h")', { cacheStore: store });
      expect(calls.random).toBe(2); // cache hit from first resolve
      expect(g3.configSchema.A.isCacheHit).toBe(true);
    });

    it('uses custom key when specified', async () => {
      const store = createTestCacheStore();

      // cache with custom key
      const g1 = await loadAndResolve('A=cache(random(), key="my-custom-key")', { cacheStore: store });
      const firstValue = g1.configSchema.A.resolvedValue;

      // same custom key — should hit cache even though item name could differ
      const g2 = await loadAndResolve('A=cache(random(), key="my-custom-key")', { cacheStore: store });
      expect(g2.configSchema.A.resolvedValue).toBe(firstValue);
      expect(g2.configSchema.A.isCacheHit).toBe(true);

      // different custom key — should NOT hit cache
      const g3 = await loadAndResolve('A=cache(random(), key="other-key")', { cacheStore: store });
      expect(g3.configSchema.A.resolvedValue).not.toBe(firstValue);
      expect(g3.configSchema.A.isCacheHit).toBe(false);
    });

    it('caches forever when no ttl specified', async () => {
      const store = createTestCacheStore();

      const g1 = await loadAndResolve('A=cache(random())', { cacheStore: store });
      const firstValue = g1.configSchema.A.resolvedValue;

      const g2 = await loadAndResolve('A=cache(random())', { cacheStore: store });
      expect(g2.configSchema.A.resolvedValue).toBe(firstValue);
      expect(g2.configSchema.A.isCacheHit).toBe(true);
    });

    it('multiple items cache independently', async () => {
      const store = createTestCacheStore();

      const g1 = await loadAndResolve(outdent`
        A=cache(random(), ttl="1h")
        B=cache(random(), ttl="1h")
      `, { cacheStore: store });
      expect(g1.configSchema.A.resolvedValue).toBeDefined();
      expect(g1.configSchema.B.resolvedValue).toBeDefined();
      expect(g1.configSchema.A.resolvedValue).not.toBe(g1.configSchema.B.resolvedValue);

      // check cache file was written
      const stats = store.getStats();
      expect(stats.total).toBe(2);

      // both should be cached on second resolve
      const g2 = await loadAndResolve(outdent`
        A=cache(random(), ttl="1h")
        B=cache(random(), ttl="1h")
      `, { cacheStore: store });
      expect(g2.configSchema.A.isCacheHit).toBe(true);
      expect(g2.configSchema.B.isCacheHit).toBe(true);
      expect(g2.configSchema.A.resolvedValue).toBe(g1.configSchema.A.resolvedValue);
      expect(g2.configSchema.B.resolvedValue).toBe(g1.configSchema.B.resolvedValue);
    });
  });

  describe('cacheTtl / isCached properties', () => {
    it('extracts TTL from cache() resolver', async () => {
      const g = await loadAndResolve('A=cache("val", ttl="2h")');
      expect(g.configSchema.A.cacheTtl).toBe('2h');
      expect(g.configSchema.A.isCached).toBe(true);
    });

    it('returns undefined TTL when no ttl specified (forever)', async () => {
      const g = await loadAndResolve('A=cache("val")');
      expect(g.configSchema.A.cacheTtl).toBeUndefined();
      expect(g.configSchema.A.isCached).toBe(true);
    });

    it('isCached is false when no cache() is used', async () => {
      const g = await loadAndResolve('A="plain"');
      expect(g.configSchema.A.isCached).toBe(false);
      expect(g.configSchema.A.cacheTtl).toBeUndefined();
    });

    it('finds cache() nested inside other resolvers', async () => {
      const g = await loadAndResolve('A=fallback(cache("val", ttl="5m"), "other")');
      expect(g.configSchema.A.cacheTtl).toBe('5m');
      expect(g.configSchema.A.isCached).toBe(true);
    });
  });

  describe('cache hit tracking', () => {
    it('reports no cache hits when no cache store', async () => {
      const g = await loadAndResolve('A=cache("val", ttl="1h")');
      expect(g.configSchema.A.isCacheHit).toBe(false);
      expect(g.configSchema.A._cacheHits).toEqual([]);
    });

    it('records cache hit info with cacheKey and timestamp', async () => {
      const store = createTestCacheStore();

      await loadAndResolve('A=cache("val", ttl="1h")', { cacheStore: store });
      const before = Date.now();
      const g2 = await loadAndResolve('A=cache("val", ttl="1h")', { cacheStore: store });

      expect(g2.configSchema.A.isCacheHit).toBe(true);
      const hit = g2.configSchema.A._cacheHits[0];
      expect(hit.cacheKey).toContain('resolver:');
      expect(hit.cacheKey).toContain(':A:');
      expect(hit.cachedAt).toBeLessThanOrEqual(before);
    });
  });

  describe('type inference', () => {
    it('infers number type from randomInt() child', async () => {
      const g = await loadAndResolve('A=cache(randomInt(1, 10))');
      const item = g.configSchema.A;
      // the value should be coerced as a number, not a string
      expect(typeof item.resolvedValue).toBe('number');
    });

    it('infers string type from randomUuid() child', async () => {
      const g = await loadAndResolve('A=cache(randomUuid())');
      const item = g.configSchema.A;
      expect(typeof item.resolvedValue).toBe('string');
    });
  });

  describe('various TTL formats in schema', () => {
    const validTtls = ['30s', '5m', '1h', '1d', '1w'];
    for (const ttl of validTtls) {
      it(`accepts ttl="${ttl}"`, async () => {
        const g = await loadAndResolve(`A=cache(random(), ttl="${ttl}")`);
        expect(g.configSchema.A.errors.length).toBe(0);
        expect(g.configSchema.A.resolvedValue).toBeDefined();
      });
    }
  });
});
