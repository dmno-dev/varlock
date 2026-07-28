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

const TEST_KEYS = ['EST_FOO', 'EST_BAR'];

function makeEnvBlob(config: Record<string, string | undefined>) {
  return JSON.stringify({
    sources: [],
    settings: {},
    config: Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, { value, isSensitive: false }]),
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
