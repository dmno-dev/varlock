/*
  Tests for how items that resolve to undefined are (not) injected into process.env.

  By default an unset item is left out of process.env entirely (matching `varlock run`
  and the documented `VAR=` semantics), so `process.env.X ?? 'fallback'` works.
  `@injectUndefinedAsEmpty` opts back into dotenv-style empty-string injection.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';

const TEST_KEYS = ['UIT_SET', 'UIT_UNSET'];

function makeEnvBlob(
  config: Record<string, string | undefined>,
  settings: Record<string, any> = {},
) {
  return JSON.stringify({
    sources: [],
    settings,
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

describe('process.env injection of undefined items', () => {
  it('does NOT inject items that resolved to undefined (default)', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ UIT_SET: 'set-value', UIT_UNSET: undefined });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.UIT_SET).toBe('set-value');
    expect(process.env.UIT_UNSET).toBeUndefined();
    expect('UIT_UNSET' in process.env).toBe(false);
    // the typed ENV object still exposes the key (as undefined)
    expect((envModule.ENV as any).UIT_UNSET).toBeUndefined();
  });

  it('clears a stale pre-existing value for a key that resolved to undefined', async () => {
    // simulates a parent-injected echo: present in process.env but excluded from
    // overrides during resolution, so the fresh resolution came back undefined
    process.env.UIT_UNSET = 'stale-parent-value';
    process.env.__VARLOCK_ENV = makeEnvBlob({ UIT_UNSET: undefined });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.UIT_UNSET).toBeUndefined();
  });

  it('injects empty strings when injectUndefinedAsEmpty is set', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob(
      { UIT_SET: 'set-value', UIT_UNSET: undefined },
      { injectUndefinedAsEmpty: true },
    );
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect(process.env.UIT_SET).toBe('set-value');
    expect(process.env.UIT_UNSET).toBe('');
  });

  it('removes a previously-injected value when the item resolves to undefined on reload', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ UIT_SET: 'set-value' });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(process.env.UIT_SET).toBe('set-value');

    process.env.__VARLOCK_ENV = makeEnvBlob({ UIT_SET: undefined });
    envModule.initVarlockEnv();
    expect(process.env.UIT_SET).toBeUndefined();
  });

  it('an explicit empty-string value is still injected as an empty string', async () => {
    process.env.__VARLOCK_ENV = makeEnvBlob({ UIT_SET: '' });
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(process.env.UIT_SET).toBe('');
  });
});
