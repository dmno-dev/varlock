/*
  Tests for initVarlockEnv behavior when the env blob was baked into the build output,
  identified by the `injectedAtBuild` flag the injection preludes bake INSIDE the
  payload: 'fallback' (webpack/turbopack runtime preludes - implicit bake, conflicts
  throw) or 'explicit' (vite `resolved-env` SSR entry - chosen bake, conflicts warn).
  Because the flag lives inside the blob, provenance travels with it to child processes
  and through encryption, and can never outlive the payload: a fresh resolution always
  produces an unflagged blob.

  A build-baked blob was resolved at BUILD time, so values in the actual runtime
  environment never had a chance to act as overrides, and cannot be validated here.
  Semantics: absent runtime values are fine (blob-only deployments), matching values are
  fine, but a CONFLICTING runtime value would be silently ignored - so it fails the boot
  loudly in 'fallback' mode (pointing at `varlock run`) and warns loudly in 'explicit'
  mode. The escape hatch `_VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS=1` downgrades the
  fallback-mode failure to a logged warning and boots on the baked values, without
  deleting runtime-provided vars from process.env.
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
  opts: { settings?: Record<string, any>, injectedAtBuild?: 'fallback' | 'explicit' } = {},
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
  delete process.env._VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS;
  for (const key of TEST_KEYS) delete process.env[key];
}

beforeEach(cleanup);
afterEach(cleanup);

describe('build-injected env blob (injectedAtBuild payload flag)', () => {
  it('blob-only boot (no runtime values present) uses baked values without error', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
    }, { injectedAtBuild: 'fallback' });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.BIE_SET).toBe('build-value');
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_UNSET).toBeUndefined();
  });

  it('throws when a runtime value conflicts with an item that resolved to undefined at build', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: 'fallback' });
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
    }, { injectedAtBuild: 'fallback' });
    const envModule = await importFreshEnvModuleCopy();

    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_SET, BIE_UNSET/);
  });

  it('a matching runtime value (raw override form) is not a conflict', async () => {
    // parent recorded `BIE_COERCED=YES` coerced to boolean true at build; the raw "YES"
    // in the runtime env is the same value, not a conflict
    process.env.BIE_COERCED = 'YES';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_COERCED: { value: true, overrideStr: 'YES' },
    }, { injectedAtBuild: 'fallback' });
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
    }, { injectedAtBuild: 'fallback' });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect((envModule.ENV as any).BIE_COERCED).toBe(true);
  });

  it('escape hatch boots on baked values, warns, and leaves runtime values in process.env', async () => {
    process.env._VARLOCK_ALLOW_ENV_SNAPSHOT_CONFLICTS = '1';
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.BIE_SET = 'runtime-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_UNSET: { value: undefined },
      BIE_SET: { value: 'build-value' },
    }, { injectedAtBuild: 'fallback' });
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

  it('conflict check applies when the blob comes via globalThis.__varlockLoadedEnv', async () => {
    process.env.BIE_UNSET = 'redis://redis:6379';
    (globalThis as any).__varlockLoadedEnv = JSON.parse(
      makeEnvBlob({ BIE_UNSET: { value: undefined } }, { injectedAtBuild: 'fallback' }),
    );
    const envModule = await importFreshEnvModuleCopy();

    expect(() => envModule.initVarlockEnv()).toThrowError(/BIE_UNSET/);
  });

  it("explicit bake ('resolved-env' style): conflicts warn loudly but boot on baked values", async () => {
    // bake-into-build is the user's declared contract in explicit mode, so a stray
    // runtime value must not kill the boot - but it is surfaced, and never deleted
    process.env.BIE_SET = 'runtime-value';
    process.env.BIE_UNSET = 'redis://redis:6379';
    process.env.__VARLOCK_ENV = makeEnvBlob({
      BIE_SET: { value: 'build-value' },
      BIE_UNSET: { value: undefined },
    }, { injectedAtBuild: 'explicit' });
    const envModule = await importFreshEnvModuleCopy();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    envModule.initVarlockEnv();
    const warned = consoleErrorSpy.mock.calls.flat().join('\n');
    consoleErrorSpy.mockRestore();

    expect(warned).toContain('BIE_SET, BIE_UNSET');
    expect((envModule.ENV as any).BIE_SET).toBe('build-value');
    expect(process.env.BIE_SET).toBe('build-value');
    expect(process.env.BIE_UNSET).toBe('redis://redis:6379');
  });

  it('an unflagged blob is treated as a fresh resolution: conflicting ambient values never throw', async () => {
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
