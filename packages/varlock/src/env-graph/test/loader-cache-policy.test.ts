import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadEnvGraph, loadVarlockConfigVarsFromFiles } from '../lib/loader';
import { CacheStore, InMemoryCacheStore } from '../../lib/cache';

// switchable local-encrypt backend so tests can simulate native vs file-fallback
let mockBackendType = 'secure-enclave';
vi.mock('../../lib/local-encrypt', () => ({
  getBackendInfo: () => ({ type: mockBackendType, isFileFallback: mockBackendType === 'file' }),
  keyExists: () => true,
  ensureKey: vi.fn(async () => undefined),
  encryptValue: vi.fn(async (v: string) => `enc:${v}`),
  decryptValue: vi.fn(async (v: string) => v.replace('enc:', '')),
}));

// isolate the cache dir in a temp location
let tempConfigDir: string;
vi.mock('../../lib/user-config-dir', () => ({
  getUserVarlockDir: () => tempConfigDir,
}));

const VALID_CACHE_KEY = crypto.randomBytes(32).toString('hex');
const keyFingerprint = crypto.createHash('sha256').update(VALID_CACHE_KEY).digest('hex').slice(0, 12);

let tempProjectDir: string;

beforeEach(() => {
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-loader-cache-config-'));
  tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-loader-cache-proj-'));
  fs.writeFileSync(path.join(tempProjectDir, '.env.schema'), [
    '# @defaultRequired=false',
    '# ---',
    'FOO=bar',
    '',
  ].join('\n'));
  mockBackendType = 'secure-enclave';
});

afterEach(() => {
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
  fs.rmSync(tempProjectDir, { recursive: true, force: true });
});

async function load(opts?: {
  processEnvOverride?: Record<string, string | undefined>;
  clearCache?: boolean;
  skipCache?: boolean;
}) {
  return loadEnvGraph({
    entryFilePaths: path.join(tempProjectDir, '.env.schema'),
    processEnvOverride: opts?.processEnvOverride ?? {},
    clearCache: opts?.clearCache,
    skipCache: opts?.skipCache,
  });
}

describe('loadEnvGraph cache auto-policy', () => {
  it('uses the native-encrypted disk store locally (native backend, not CI)', async () => {
    const graph = await load();
    expect(graph._cacheMode).toBe('disk');
    expect(graph._cacheStore).toBeInstanceOf(CacheStore);
    expect((graph._cacheStore as CacheStore).getFilePath().endsWith('varlock-default.json')).toBe(true);
  });

  it('falls back to memory in CI without a cache key', async () => {
    const graph = await load({ processEnvOverride: { CI: 'true' } });
    expect(graph._cacheMode).toBe('memory');
    expect(graph._cacheStore).toBeInstanceOf(InMemoryCacheStore);
  });

  it('falls back to memory with the file-based encryption fallback', async () => {
    mockBackendType = 'file';
    const graph = await load();
    expect(graph._cacheMode).toBe('memory');
    expect(graph._cacheStore).toBeInstanceOf(InMemoryCacheStore);
  });

  it('uses the env-key disk store in CI when _VARLOCK_CACHE_KEY is set', async () => {
    const graph = await load({ processEnvOverride: { CI: 'true', _VARLOCK_CACHE_KEY: VALID_CACHE_KEY } });
    expect(graph._cacheMode).toBe('disk');
    expect(graph._cacheStore).toBeInstanceOf(CacheStore);
    expect((graph._cacheStore as CacheStore).getFilePath().endsWith(`env-key-${keyFingerprint}.json`)).toBe(true);
  });

  it('prefers the native backend over _VARLOCK_CACHE_KEY outside CI', async () => {
    const graph = await load({ processEnvOverride: { _VARLOCK_CACHE_KEY: VALID_CACHE_KEY } });
    expect((graph._cacheStore as CacheStore).getFilePath().endsWith('varlock-default.json')).toBe(true);
  });

  it('honors a _VARLOCK_CACHE_KEY set in a .env.local file', async () => {
    fs.writeFileSync(path.join(tempProjectDir, '.env.local'), `_VARLOCK_CACHE_KEY=${VALID_CACHE_KEY}\n`);
    const graph = await loadEnvGraph({
      entryFilePaths: tempProjectDir,
      processEnvOverride: { CI: 'true' },
    });
    expect(graph.varlockConfigVarsFromFiles._VARLOCK_CACHE_KEY).toBe(VALID_CACHE_KEY);
    expect(graph._cacheMode).toBe('disk');
    expect((graph._cacheStore as CacheStore).getFilePath().endsWith(`env-key-${keyFingerprint}.json`)).toBe(true);
  });

  it('lets a real _VARLOCK_CACHE_KEY env var override the .env.local value', async () => {
    const realKey = crypto.randomBytes(32).toString('hex');
    const realFingerprint = crypto.createHash('sha256').update(realKey).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(tempProjectDir, '.env.local'), `_VARLOCK_CACHE_KEY=${VALID_CACHE_KEY}\n`);
    const graph = await loadEnvGraph({
      entryFilePaths: tempProjectDir,
      processEnvOverride: { CI: 'true', _VARLOCK_CACHE_KEY: realKey },
    });
    expect((graph._cacheStore as CacheStore).getFilePath().endsWith(`env-key-${realFingerprint}.json`)).toBe(true);
  });

  it('falls back to memory when _VARLOCK_CACHE_KEY is invalid', async () => {
    const graph = await load({ processEnvOverride: { CI: 'true', _VARLOCK_CACHE_KEY: 'not-a-valid-key' } });
    expect(graph._cacheMode).toBe('memory');
    expect(graph._cacheStore).toBeInstanceOf(InMemoryCacheStore);
  });

  it('loadVarlockConfigVarsFromFiles does a parse-only extraction of file config vars', async () => {
    fs.writeFileSync(path.join(tempProjectDir, '.env.local'), [
      `_VARLOCK_CACHE_KEY=${VALID_CACHE_KEY}`,
      '_VARLOCK_REDACT_STDOUT=true',
      '',
    ].join('\n'));
    const fileVars = await loadVarlockConfigVarsFromFiles(tempProjectDir);
    expect(fileVars._VARLOCK_CACHE_KEY).toBe(VALID_CACHE_KEY);
    expect(fileVars._VARLOCK_REDACT_STDOUT).toBe('true');
  });

  it('loadVarlockConfigVarsFromFiles returns {} for a directory with no .env files', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-empty-'));
    try {
      expect(await loadVarlockConfigVarsFromFiles(emptyDir)).toEqual({});
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('creates no store with --skip-cache', async () => {
    const graph = await load({ skipCache: true });
    expect(graph._skipCacheMode).toBe(true);
    expect(graph._cacheStore).toBeUndefined();
  });
});

describe('loadEnvGraph --clear-cache', () => {
  function writeCacheFile(fileName: string) {
    const cacheDir = path.join(tempConfigDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify({
      'plugin:test:k': { v: 'enc:whatever', c: Date.now(), e: Date.now() + 60_000 },
    }));
    return filePath;
  }

  it('clears the default disk cache, even when combined with --skip-cache', async () => {
    const filePath = writeCacheFile('varlock-default.json');
    await load({ clearCache: true, skipCache: true });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({});
  });

  it('also clears the env-key cache file when _VARLOCK_CACHE_KEY is set', async () => {
    const defaultPath = writeCacheFile('varlock-default.json');
    const envKeyPath = writeCacheFile(`env-key-${keyFingerprint}.json`);
    await load({
      clearCache: true,
      processEnvOverride: { CI: 'true', _VARLOCK_CACHE_KEY: VALID_CACHE_KEY },
    });
    expect(JSON.parse(fs.readFileSync(defaultPath, 'utf-8'))).toEqual({});
    expect(JSON.parse(fs.readFileSync(envKeyPath, 'utf-8'))).toEqual({});
  });

  it('does not touch other key fingerprints cache files', async () => {
    const otherPath = writeCacheFile('env-key-aaaabbbbcccc.json');
    await load({ clearCache: true });
    expect(Object.keys(JSON.parse(fs.readFileSync(otherPath, 'utf-8')))).toHaveLength(1);
  });
});
