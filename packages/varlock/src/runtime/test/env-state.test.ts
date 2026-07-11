/*
  Tests for the shared-on-globalThis env runtime state — specifically that env
  loads/reloads behave correctly when a bundler creates MULTIPLE copies of the
  varlock/env module in one process (e.g. Next.js bundling it into app-router and
  pages-router server code while @next/env uses the node_modules copy).

  Each "module copy" is simulated with vi.resetModules() + a fresh dynamic import.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';

const TEST_KEYS = ['EST_FOO', 'EST_BAR', 'EST_EXCLUDED', 'EST_SECRET'];

function makeEnvBlob(config: Record<string, string | undefined>) {
  return JSON.stringify({
    sources: [],
    settings: {},
    config: Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, { value, isSensitive: false }]),
    ),
  });
}

type ConfigItemInput = { value?: any, isSensitive?: boolean, valueExcluded?: boolean };
function makeConfigBlob(config: Record<string, ConfigItemInput>) {
  return JSON.stringify({
    sources: [],
    settings: {},
    config: Object.fromEntries(
      Object.entries(config).map(([key, item]) => [
        key, {
          isSensitive: item.isSensitive ?? false,
          // omit `value` entirely for excluded items — the runtime reads it from process.env
          ...('value' in item ? { value: item.value } : {}),
          ...(item.valueExcluded ? { valueExcluded: true } : {}),
        },
      ]),
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

describe('env state shared across module copies', () => {
  it('a second module copy sees env already initialized and reads the same values', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ EST_FOO: 'foo-1' });
    const copyA = await importFreshEnvModuleCopy();
    copyA.initVarlockEnv();
    expect((copyA.ENV as any).EST_FOO).toBe('foo-1');

    const copyB = await importFreshEnvModuleCopy();
    expect(copyB).not.toBe(copyA);
    // no explicit init on copyB — it must pick up the shared initialized state
    expect((copyB.ENV as any).EST_FOO).toBe('foo-1');
  });

  it('a reload through a second module copy updates values seen by the first copy', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ EST_FOO: 'foo-1' });
    const copyA = await importFreshEnvModuleCopy();
    copyA.initVarlockEnv();

    const copyB = await importFreshEnvModuleCopy();
    process.env.__VARLOCK_ENV = makeEnvBlob({ EST_FOO: 'foo-2' });
    copyB.initVarlockEnv();

    expect((copyA.ENV as any).EST_FOO).toBe('foo-2');
    expect(process.env.EST_FOO).toBe('foo-2');
  });

  it('a reload through a second module copy cleans up keys removed from config', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ EST_FOO: 'foo-1', EST_BAR: 'bar-1' });
    const copyA = await importFreshEnvModuleCopy();
    copyA.initVarlockEnv();
    expect(process.env.EST_FOO).toBe('foo-1');
    expect(process.env.EST_BAR).toBe('bar-1');

    // reload flows through a DIFFERENT module copy, with EST_BAR removed
    const copyB = await importFreshEnvModuleCopy();
    process.env.__VARLOCK_ENV = makeEnvBlob({ EST_FOO: 'foo-2' });
    copyB.initVarlockEnv();

    expect(process.env.EST_FOO).toBe('foo-2');
    // injection bookkeeping is shared, so the removed key is cleaned up
    expect(process.env.EST_BAR).toBeUndefined();
    // and the removed key is also dropped from the ENV values (read via either copy)
    expect((copyB.ENV as any).EST_BAR).toBeUndefined();
    expect((copyA.ENV as any).EST_BAR).toBeUndefined();
  });

  it('treats a still-encrypted blob as not yet available', async () => {
    process.env.__VARLOCK_ENV = 'varlock:v1:bm90LXJlYWwtZGF0YQ==';
    // module-load auto-init uses allowFail and must not explode
    const envModule = await importFreshEnvModuleCopy();
    // explicit init without allowFail should throw a clear error
    expect(() => envModule.initVarlockEnv()).toThrow(/still encrypted/);
    // and env should not be marked initialized
    expect(() => (envModule.ENV as any).ANYTHING).toThrow(/not initialized/);
  });
});

describe('excluded sensitive values fall back to process.env', () => {
  it('reads the platform-provided process.env value and does not clobber it', async () => {
    process.env.EST_EXCLUDED = 'from-platform';
    process.env.__VARLOCK_ENV = makeConfigBlob({
      EST_EXCLUDED: { isSensitive: true, valueExcluded: true },
    });
    const copy = await importFreshEnvModuleCopy();
    copy.initVarlockEnv();
    expect((copy.ENV as any).EST_EXCLUDED).toBe('from-platform');
    // the platform-provided value must survive init, not be overwritten with ''
    expect(process.env.EST_EXCLUDED).toBe('from-platform');
  });

  it('yields undefined when process.env has no value for the excluded key', async () => {
    delete process.env.EST_EXCLUDED;
    process.env.__VARLOCK_ENV = makeConfigBlob({
      EST_EXCLUDED: { isSensitive: true, valueExcluded: true },
    });
    const copy = await importFreshEnvModuleCopy();
    copy.initVarlockEnv();
    expect((copy.ENV as any).EST_EXCLUDED).toBeUndefined();
    // must not materialize the key as an empty string in process.env
    expect('EST_EXCLUDED' in process.env).toBe(false);
  });

  it('a normal sensitive item with a value is still injected as before', async () => {
    process.env.__VARLOCK_ENV = makeConfigBlob({
      EST_SECRET: { isSensitive: true, value: 'real-secret' },
    });
    const copy = await importFreshEnvModuleCopy();
    copy.initVarlockEnv();
    expect((copy.ENV as any).EST_SECRET).toBe('real-secret');
    expect(process.env.EST_SECRET).toBe('real-secret');
  });
});
