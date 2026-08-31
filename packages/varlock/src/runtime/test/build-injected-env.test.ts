/*
  Tests for initVarlockEnv behavior when the env blob was baked into the build output
  and used as a boot-time fallback, marked via `globalThis.__varlockEnvInjectedAtBuild`
  (set by the webpack/turbopack runtime preludes and vite `resolved-env` SSR entry,
  mirrored into `__VARLOCK_ENV_INJECTED_AT_BUILD` for child processes).

  A build-baked blob was resolved at BUILD time, so values in the actual runtime
  environment never had a chance to act as overrides, and cannot be validated here.
  Semantics: absent runtime values are fine (blob-only deployments), matching values are
  fine, but a CONFLICTING runtime value is a misconfiguration (it would be silently
  ignored) and fails the boot loudly, pointing at `varlock run`. The escape hatch
  `_VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS=1` downgrades the failure to a logged warning and
  boots on the baked values, without deleting runtime-provided vars from process.env.
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
function makeEnvBlob(config: Record<string, BlobItem>, settings: Record<string, any> = {}) {
  return JSON.stringify({
    sources: [],
    settings,
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
  delete (globalThis as any).__varlockEnvInjectedAtBuild;
  delete process.env.__VARLOCK_ENV;
  delete process.env.__VARLOCK_ENV_INJECTED_AT_BUILD;
  delete process.env._VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS;
  for (const key of TEST_KEYS) delete process.env[key];
}

beforeEach(cleanup);
afterEach(cleanup);

describe('build-injected env blob (__varlockEnvInjectedAtBuild)', () => {
  it('blob-only boot (no runtime values present) uses baked values without error', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
    });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_SET).toBe('build-value');
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_UNSET).toBeUndefined();
  });

  it('throws when a runtime value conflicts with an item that resolved to undefined at build', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();

    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_UNSET/);
    expect(() => envModule.initVarlockEnv()).toThrowError(/varlock run/);
    // the conflicting runtime value must never be deleted
    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('throws when a runtime value conflicts with a build-time value, naming all conflicting keys', async () => {
    process.env.BIE_SET = 'runtime-value';
    process.env.BIE_UNSET = 'another-runtime-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
      BIE_BLOB_ONLY: { value: 'blob-only-value' },
    });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();

    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_SET, BIE_UNSET/);
  });

  it('a matching runtime value (raw override form) is not a conflict', async () => {
    // parent recorded `BIE_COERCED=YES` coerced to boolean true at build; the raw "YES"
    // in the runtime env is the same value, not a conflict
    process.env.BIE_COERCED = 'YES';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_COERCED: { value: true, overrideStr: 'YES' } });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_COERCED).toBe('true');
    expect((envModule.ENV as any).BIE_COERCED).toBe(true);
  });

  it('escape hatch boots on baked values, warns, and leaves runtime values in process.env', async () => {
    process.env._VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS = '1';
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.BIE_SET = 'runtime-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_UNSET: { value: undefined },
      BIE_SET: { value: 'build-value' },
    });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    envModule.initVarlockEnv();
    const warned = consoleErrorSpy.mock.calls.flat().join('\n');
    consoleErrorSpy.mockRestore();

    expect(warned).toContain('BIE_UNSET');
    // baked values are authoritative for ENV and defined items
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_SET).toBe('build-value');
    expect((envModule.ENV as any).BIE_UNSET).toBeUndefined();
    // but a runtime-provided value for an unset item is never deleted
    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('marker is mirrored to __VARLOCK_ENV_INJECTED_AT_BUILD and honored from it', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_SET: { value: 'build-value' } });
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    let envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(process.env.__VARLOCK_ENV_INJECTED_AT_BUILD).toBe('1');

    // simulate a child process: env-var mirror inherited, globalThis marker absent
    cleanup();
    process.env.__VARLOCK_ENV_INJECTED_AT_BUILD = '1';
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } });
    envModule = await importFreshEnvModuleCopy();
    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_UNSET/);
  });

  it('conflict check applies when the blob comes via globalThis.__varlockLoadedEnv', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    (globalThis as any).__varlockLoadedEnv = JSON.parse(makeEnvBlob({ BIE_UNSET: { value: undefined } }));
    (globalThis as any).__varlockEnvInjectedAtBuild = true;
    const envModule = await importFreshEnvModuleCopy();

    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_UNSET/);
  });

  it('without the marker, existing fresh-load semantics are unchanged (stale echo cleared)', async () => {
    process.env.BIE_UNSET = 'stale-parent-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_UNSET).toBeUndefined();
  });
});
