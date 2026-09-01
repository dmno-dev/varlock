/*
  Tests for initVarlockEnv behavior when the env blob was baked into the build output,
  identified by the `injectedAtBuild: true` flag the injection preludes (webpack/turbopack
  runtime preludes, vite `resolved-env` SSR entry) bake INSIDE the payload. Because the
  flag lives inside the blob, provenance travels with it to child processes and through
  encryption, and can never outlive the payload: a fresh resolution always produces an
  unflagged blob.

  A build-baked blob was resolved at BUILD time, so the stale-echo cleanup (which assumes
  a resolution happened in this process) must not run against it. Baked values stay
  authoritative for ENV, but runtime-provided values are never deleted from process.env.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';

const TEST_KEYS = ['BIE_UNSET', 'BIE_SET', 'BIE_BLOB_ONLY'];

type BlobItem = { value?: any, envStr?: string, isSensitive?: boolean };
function makeEnvBlob(
  config: Record<string, BlobItem>,
  opts: { settings?: Record<string, any>, injectedAtBuild?: boolean } = {},
) {
  return JSON.stringify({
    sources: [],
    settings: opts.settings || {},
    ...(opts.injectedAtBuild ? { injectedAtBuild: opts.injectedAtBuild } : {}),
    config: Object.fromEntries(
      Object.entries(config).map(([key, item]) => [key, { isSensitive: false, ...item }]),
    ),
  });
}

async function importFreshEnvModuleCopy() {
  vi.resetModules();
  return import('../env');
}

function cleanup() {
  delete (globalThis as any)[ENV_STATE_KEY];
  delete (globalThis as any)[REDACTION_STATE_KEY];
  delete (globalThis as any).__varlockLoadedEnv;
  delete process.env.__VARLOCK_ENV;
  for (const key of TEST_KEYS) delete process.env[key];
}

beforeEach(cleanup);
afterEach(cleanup);

describe('build-injected env blob (injectedAtBuild payload flag)', () => {
  it('keeps a runtime value for an item that resolved to undefined at build time', async () => {
    // the reported regression: this value used to be DELETED from process.env, taking
    // down a standalone container booted with `docker run -e REDIS_URL=...`
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('baked values stay authoritative for defined items', async () => {
    process.env.BIE_SET = 'runtime-value';
    process.env.BIE_UNSET = 'another-runtime-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
      BIE_BLOB_ONLY: { value: 'blob-only-value' },
    }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_SET).toBe('build-value');
    expect(process.env.BIE_BLOB_ONLY).toBe('blob-only-value');
    // but a runtime value for an item that resolved to undefined is left alone
    expect(process.env.BIE_UNSET).toBe('another-runtime-value');
  });

  it('blob-only boot (no runtime values present) uses baked values', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
    }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_SET).toBe('build-value');
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_UNSET).toBeUndefined();
  });

  it('applies when the blob comes via globalThis.__varlockLoadedEnv (vite resolved-env)', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    (globalThis as any).__varlockLoadedEnv = JSON.parse(
      makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: true }),
    );
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('an unflagged blob is a fresh resolution: stale-echo cleanup still applies', async () => {
    // provenance lives inside the payload, so replacing a baked blob with a freshly
    // resolved one (auto-load, next compat, vite reload) inherently clears it - a fresh
    // blob must keep existing semantics no matter what booted earlier
    process.env.BIE_UNSET = 'stale-parent-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_UNSET).toBeUndefined();
  });
});
