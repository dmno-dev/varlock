/**
 * Which key protects cache entries.
 *
 * Runs the real encryption stack (forced onto the file backend) rather than a
 * stub codec, because the thing under test is exactly which key CacheStore
 * reaches for.
 */

import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEVICE_PAYLOAD_VERSION, IDENTITY_PAYLOAD_VERSION } from '../local-encrypt/crypto';

process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';

let tempDir: string;
vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => tempDir,
}));

let CacheStore: typeof import('./cache-store')['CacheStore'];

/** Version byte of the stored ciphertext for one cache entry */
function storedEntryVersion(keyId: string, cacheKey: string) {
  const raw = JSON.parse(fs.readFileSync(path.join(tempDir, 'cache', `${keyId}.json`), 'utf-8'));
  return Buffer.from(raw[cacheKey].v, 'base64')[0];
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-cache-identity-test-'));
  vi.resetModules();
  process.env._VARLOCK_FORCE_FILE_ENCRYPTION_FALLBACK = '1';
  delete process.env._VARLOCK_DISABLE_IDENTITY;
  CacheStore = (await import('./cache-store')).CacheStore;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env._VARLOCK_DISABLE_IDENTITY;
});

describe('cache key selection', () => {
  it('encrypts cache entries to the identity key on the file backend', async () => {
    const store = new CacheStore('varlock-default');
    await store.set('plugin:test:key', 'cached value', 60_000);

    expect(storedEntryVersion('varlock-default', 'plugin:test:key')).toBe(IDENTITY_PAYLOAD_VERSION);
    expect(fs.existsSync(path.join(tempDir, 'identities', 'default.json'))).toBe(true);
  });

  it('round-trips a cached value through the identity key', async () => {
    const store = new CacheStore('varlock-default');
    await store.set('plugin:test:key', { nested: [1, 2, 3] }, 60_000);

    const result = await store.get('plugin:test:key');
    expect(result!.value).toEqual({ nested: [1, 2, 3] });
  });

  it('reads entries back in a later process', async () => {
    const first = new CacheStore('varlock-default');
    await first.set('plugin:test:key', 'persisted', 60_000);

    vi.resetModules();
    const ReloadedCacheStore = (await import('./cache-store')).CacheStore;
    const second = new ReloadedCacheStore('varlock-default');
    expect((await second.get('plugin:test:key'))!.value).toBe('persisted');
  });

  it('falls back to the device key when the identity layer is switched off', async () => {
    process.env._VARLOCK_DISABLE_IDENTITY = '1';
    vi.resetModules();
    const OptedOutCacheStore = (await import('./cache-store')).CacheStore;

    const store = new OptedOutCacheStore('varlock-default');
    await store.set('plugin:test:key', 'cached value', 60_000);

    expect(storedEntryVersion('varlock-default', 'plugin:test:key')).toBe(DEVICE_PAYLOAD_VERSION);
    expect(fs.existsSync(path.join(tempDir, 'identities', 'default.json'))).toBe(false);
    expect((await store.get('plugin:test:key'))!.value).toBe('cached value');
  });

  it('still reads entries written to the device key before the identity existed', async () => {
    process.env._VARLOCK_DISABLE_IDENTITY = '1';
    vi.resetModules();
    const legacyStore = new ((await import('./cache-store')).CacheStore)('varlock-default');
    await legacyStore.set('plugin:test:key', 'written as v1', 60_000);
    expect(storedEntryVersion('varlock-default', 'plugin:test:key')).toBe(DEVICE_PAYLOAD_VERSION);

    delete process.env._VARLOCK_DISABLE_IDENTITY;
    vi.resetModules();
    const upgradedStore = new ((await import('./cache-store')).CacheStore)('varlock-default');
    expect((await upgradedStore.get('plugin:test:key'))!.value).toBe('written as v1');
  });
});
