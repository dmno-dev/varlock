import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheStore } from './cache-store';

// mock localEncrypt to avoid needing real encryption keys
vi.mock('../local-encrypt', () => ({
  encryptValue: vi.fn(async (value: string) => `encrypted:${value}`),
  decryptValue: vi.fn(async (value: string) => value.replace('encrypted:', '')),
}));

// mock getUserVarlockDir to use a temp directory
let tempDir: string;
vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => tempDir,
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-cache-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('CacheStore', () => {
  describe('get/set', () => {
    it('returns undefined for missing key', async () => {
      const store = new CacheStore();
      const result = await store.get('missing:key');
      expect(result).toBeUndefined();
    });

    it('stores and retrieves a value', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:mykey', 'hello', 60_000);
      const result = await store.get('plugin:test:mykey');
      expect(result).toBeDefined();
      expect(result!.value).toBe('hello');
    });

    it('returns cachedAt timestamp', async () => {
      const store = new CacheStore();
      const before = Date.now();
      await store.set('plugin:test:ts', 'val', 60_000);
      const after = Date.now();
      const result = await store.get('plugin:test:ts');
      expect(result!.cachedAt).toBeGreaterThanOrEqual(before);
      expect(result!.cachedAt).toBeLessThanOrEqual(after);
    });

    it('overwrites existing value', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:k', 'v1', 60_000);
      await store.set('plugin:test:k', 'v2', 60_000);
      const result = await store.get('plugin:test:k');
      expect(result!.value).toBe('v2');
    });
  });

  describe('expiry', () => {
    it('returns undefined for expired entry', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:exp', 'val', 1); // 1ms TTL
      // wait for expiry
      await new Promise<void>((r) => {
        setTimeout(r, 10);
      });
      const result = await store.get('plugin:test:exp');
      expect(result).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes a specific entry', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:a', 'va', 60_000);
      await store.set('plugin:test:b', 'vb', 60_000);
      store.delete('plugin:test:a');
      expect(await store.get('plugin:test:a')).toBeUndefined();
      expect((await store.get('plugin:test:b'))!.value).toBe('vb');
    });
  });

  describe('clearAll', () => {
    it('clears all entries and returns count', async () => {
      const store = new CacheStore();
      await store.set('plugin:a:1', 'v1', 60_000);
      await store.set('plugin:b:2', 'v2', 60_000);
      const count = store.clearAll();
      expect(count).toBe(2);
      expect(await store.get('plugin:a:1')).toBeUndefined();
      expect(await store.get('plugin:b:2')).toBeUndefined();
    });

    it('returns 0 when empty', () => {
      const store = new CacheStore();
      expect(store.clearAll()).toBe(0);
    });
  });

  describe('clearByPrefix', () => {
    it('clears only entries matching prefix', async () => {
      const store = new CacheStore();
      await store.set('plugin:1password:a', 'v1', 60_000);
      await store.set('plugin:1password:b', 'v2', 60_000);
      await store.set('plugin:aws:c', 'v3', 60_000);
      await store.set('resolver:file:item:text', 'v4', 60_000);

      const count = store.clearByPrefix('plugin:1password:');
      expect(count).toBe(2);
      expect(await store.get('plugin:1password:a')).toBeUndefined();
      expect(await store.get('plugin:1password:b')).toBeUndefined();
      expect((await store.get('plugin:aws:c'))!.value).toBe('v3');
      expect((await store.get('resolver:file:item:text'))!.value).toBe('v4');
    });
  });

  describe('getStats', () => {
    it('returns correct stats', async () => {
      const store = new CacheStore();
      await store.set('plugin:1password:a', 'v1', 60_000);
      await store.set('plugin:1password:b', 'v2', 60_000);
      await store.set('plugin:aws:c', 'v3', 60_000);
      await store.set('resolver:/path:ITEM:text()', 'v4', 60_000);

      const stats = store.getStats();
      expect(stats.total).toBe(4);
      expect(stats.expired).toBe(0);
      expect(stats.byPrefix['plugin:1password']).toBe(2);
      expect(stats.byPrefix['plugin:aws']).toBe(1);
      expect(stats.byPrefix['resolver:/path']).toBe(1);
    });
  });

  describe('persistence', () => {
    it('persists across new CacheStore instances', async () => {
      const store1 = new CacheStore();
      await store1.set('plugin:test:persist', 'persistent-value', 60_000);

      const store2 = new CacheStore();
      const result = await store2.get('plugin:test:persist');
      expect(result!.value).toBe('persistent-value');
    });
  });

  describe('type preservation', () => {
    it('preserves number type', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:num', 42, 60_000);
      const result = await store.get('plugin:test:num');
      expect(result!.value).toBe(42);
      expect(typeof result!.value).toBe('number');
    });

    it('preserves boolean type', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:bool', true, 60_000);
      const result = await store.get('plugin:test:bool');
      expect(result!.value).toBe(true);
      expect(typeof result!.value).toBe('boolean');
    });

    it('preserves object type', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:obj', { foo: 'bar', num: 1 }, 60_000);
      const result = await store.get('plugin:test:obj');
      expect(result!.value).toEqual({ foo: 'bar', num: 1 });
    });

    it('preserves array type', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:arr', [1, 'two', true], 60_000);
      const result = await store.get('plugin:test:arr');
      expect(result!.value).toEqual([1, 'two', true]);
    });
  });

  describe('encryption', () => {
    it('stores encrypted JSON-serialized values in the file', async () => {
      const store = new CacheStore();
      await store.set('plugin:test:enc', 'secret', 60_000);

      const raw = fs.readFileSync(store.getFilePath(), 'utf-8');
      const data = JSON.parse(raw);
      // value should be encrypted JSON, not plaintext
      expect(data['plugin:test:enc'].v).toBe('encrypted:"secret"');
      expect(data['plugin:test:enc'].v).not.toBe('secret');
    });
  });

  describe('graceful degradation', () => {
    it('handles missing cache file gracefully', async () => {
      const store = new CacheStore();
      // no file exists yet
      const result = await store.get('anything');
      expect(result).toBeUndefined();
    });

    it('handles corrupted cache file gracefully', async () => {
      const store = new CacheStore();
      // write garbage to the cache file
      const dir = path.dirname(store.getFilePath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(store.getFilePath(), 'not valid json');

      const result = await store.get('anything');
      expect(result).toBeUndefined();
    });
  });
});
