import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createEnvKeyCacheStore, getCacheEnvKey } from './env-key-cache-store';

// use a temp dir so tests never touch the real user cache
let tempDir: string;
vi.mock('../user-config-dir', () => ({
  getUserVarlockDir: () => tempDir,
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-envkey-cache-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const VALID_KEY = crypto.randomBytes(32).toString('hex');

describe('createEnvKeyCacheStore', () => {
  it('round-trips values with real AES-256-GCM encryption', async () => {
    const store = createEnvKeyCacheStore(VALID_KEY);
    await store.set('plugin:test:k', { secret: 'value' }, 60_000);
    const result = await store.get('plugin:test:k');
    expect(result?.value).toEqual({ secret: 'value' });

    // on-disk value is an encrypted blob, not plaintext
    const raw = fs.readFileSync(store.getFilePath(), 'utf-8');
    expect(raw).not.toContain('value');
    expect(JSON.parse(raw)['plugin:test:k'].v).toMatch(/^varlock:v1:/);
  });

  it('names the cache file by key fingerprint', () => {
    const store = createEnvKeyCacheStore(VALID_KEY);
    const expectedFingerprint = crypto.createHash('sha256').update(VALID_KEY).digest('hex').slice(0, 12);
    expect(path.basename(store.getFilePath())).toBe(`env-key-${expectedFingerprint}.json`);
  });

  it('different keys use different files and cannot read each other', async () => {
    const otherKey = crypto.randomBytes(32).toString('hex');
    const store1 = createEnvKeyCacheStore(VALID_KEY);
    const store2 = createEnvKeyCacheStore(otherKey);
    expect(store1.getFilePath()).not.toBe(store2.getFilePath());

    await store1.set('plugin:test:k', 'v1', 60_000);
    expect(await store2.get('plugin:test:k')).toBeUndefined();
  });

  it('rejects invalid keys immediately', () => {
    expect(() => createEnvKeyCacheStore('not-hex')).toThrow();
    expect(() => createEnvKeyCacheStore('abcd')).toThrow();
    expect(() => createEnvKeyCacheStore('')).toThrow();
  });

  it('treats entries encrypted with a rotated key as misses', async () => {
    const store1 = createEnvKeyCacheStore(VALID_KEY);
    await store1.set('plugin:test:k', 'old-value', 60_000);

    // simulate a rotated key being pointed at the old file
    const otherKey = crypto.randomBytes(32).toString('hex');
    const store2 = createEnvKeyCacheStore(otherKey);
    fs.copyFileSync(store1.getFilePath(), store2.getFilePath());

    expect(await store2.get('plugin:test:k')).toBeUndefined();
  });
});

describe('getCacheEnvKey', () => {
  it('reads from the provided env object', () => {
    expect(getCacheEnvKey({ _VARLOCK_CACHE_KEY: 'abc' })).toBe('abc');
    expect(getCacheEnvKey({})).toBeUndefined();
    expect(getCacheEnvKey({ _VARLOCK_CACHE_KEY: '' })).toBeUndefined();
  });
});
