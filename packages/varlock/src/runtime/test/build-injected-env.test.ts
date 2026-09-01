/*
  Tests for initVarlockEnv behavior when the env blob was baked into the build output,
  identified by the `injectedAtBuild: true` flag the injection preludes (webpack/turbopack
  runtime preludes, vite `resolved-env` SSR entry) bake INSIDE the payload. Because the
  flag lives inside the blob, provenance travels with it to child processes and through
  encryption, and can never outlive the payload: a fresh resolution always produces an
  unflagged blob.

  A build-baked blob was resolved at BUILD time, so values in the actual runtime
  environment never had a chance to act as overrides, and cannot be validated here.
  Semantics: the boot is never blocked. Runtime-provided values are never deleted from
  process.env (the regression this fixes), baked values stay authoritative for ENV, and a
  runtime value that DIFFERS from the snapshot is logged as a warning so the otherwise
  silent mismatch is visible.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';

const TEST_KEYS = ['BIE_UNSET', 'BIE_SET', 'BIE_COERCED', 'BIE_BLOB_ONLY'];

type BlobItem = {
  value?: any, envStr?: string, overrideStr?: string, isSensitive?: boolean,
};
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
  it('blob-only boot (no runtime values present) uses baked values without error', async () => {
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

  it('warns (never throws) and keeps a runtime value for an item that resolved to undefined at build', async () => {
    // the reported regression: this value used to be DELETED from process.env
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => envModule.initVarlockEnv()).not.toThrow();
    const warned = consoleErrorSpy.mock.calls.flat().join('\n');
    consoleErrorSpy.mockRestore();

    expect(warned).toContain('BIE_UNSET');
    expect(warned).toContain('varlock run');
    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('names every differing key in the warning, and baked values stay authoritative', async () => {
    process.env.BIE_SET = 'runtime-value';
    process.env.BIE_UNSET = 'another-runtime-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
      BIE_BLOB_ONLY: { value: 'blob-only-value' },
    }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    envModule.initVarlockEnv();
    const warned = consoleErrorSpy.mock.calls.flat().join('\n');
    consoleErrorSpy.mockRestore();

    expect(warned).toContain('BIE_SET, BIE_UNSET');
    // baked values are authoritative for ENV and for defined items in process.env
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_SET).toBe('build-value');
    // but a runtime value for an unset item is left alone
    expect(process.env.BIE_UNSET).toBe('another-runtime-value');
  });

  it('a matching runtime value (raw override form) is not a conflict', async () => {
    // parent recorded `BIE_COERCED=YES` coerced to boolean true at build; the raw "YES"
    // in the runtime env is the same value, not a conflict
    process.env.BIE_COERCED = 'YES';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_COERCED: { value: true, overrideStr: 'YES' },
    }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_COERCED).toBe('true');
    expect((envModule.ENV as any).BIE_COERCED).toBe(true);
  });

  it('a coerced value with no recorded raw form cannot be verified and is not a conflict', async () => {
    // `overrideStr` is omitted for sensitive items on purpose (the blob must not carry a
    // value variant the redaction map doesn't know about), and never recorded for values
    // that came from files. The ambient raw form is then unverifiable - it must NOT be
    // reported as a conflict (e.g. the same YES present at both build and runtime).
    process.env.BIE_COERCED = 'YES';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_COERCED: { value: true, envStr: 'true', isSensitive: true },
    }, { injectedAtBuild: true });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect((envModule.ENV as any).BIE_COERCED).toBe(true);
  });

  it('the check applies when the blob comes via globalThis.__varlockLoadedEnv', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    (globalThis as any).__varlockLoadedEnv = JSON.parse(
      makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: true }),
    );
    const envModule = await importFreshEnvModuleCopy();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    envModule.initVarlockEnv();
    const warned = consoleErrorSpy.mock.calls.flat().join('\n');
    consoleErrorSpy.mockRestore();

    expect(warned).toContain('BIE_UNSET');
    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('an unflagged blob is treated as a fresh resolution: ambient values never warn', async () => {
    // provenance lives inside the payload, so replacing a baked blob with a freshly
    // resolved one (auto-load, next compat, vite reload) inherently clears it - a fresh
    // blob must never trip the baked-snapshot guard no matter what booted earlier
    process.env.BIE_SET = 'something-else';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_SET: { value: 'fresh-value' } });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_SET).toBe('fresh-value');
    expect((envModule.ENV as any).BIE_SET).toBe('fresh-value');
  });

  it('without the flag, existing fresh-load semantics are unchanged (stale echo cleared)', async () => {
    process.env.BIE_UNSET = 'stale-parent-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_UNSET).toBeUndefined();
  });
});
