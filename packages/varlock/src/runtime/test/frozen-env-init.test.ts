/*
  Tests for initVarlockEnv with a frozen env (`frozen: true`), as baked into a bundle by a
  framework integration (the bundle route).

  A frozen env is total: its values win over the environment at boot and process.env is kept in
  agreement, except for `@dynamic=boot` items, whose boot values are applied by the
  `varlock/frozen-env-boot` bundle when an integration prepends it. Other keys whose boot value
  differs from the frozen one get a single warning.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const ENV_STATE_KEY = '__varlockEnvState';
const REDACTION_STATE_KEY = '__varlockRedactionState';
const BOOT_HANDLER_KEY = '__varlockApplyFrozenBootValues';

const TEST_KEYS = ['FZ_PUBLIC', 'FZ_SECRET', 'FZ_UNSET', 'FZ_PORT'];

type BlobItem = {
  value?: any, isSensitive?: boolean, boot?: { type: string, typeArgs?: Array<any>, required: boolean },
};
function makeFrozenBlob(config: Record<string, BlobItem>) {
  return JSON.stringify({
    sources: [],
    settings: {},
    frozen: true,
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
  delete (globalThis as any)[BOOT_HANDLER_KEY];
  delete (globalThis as any).__varlockLoadedEnv;
  delete process.env.__VARLOCK_ENV;
  for (const key of TEST_KEYS) delete process.env[key];
  vi.restoreAllMocks();
}

beforeEach(cleanup);
afterEach(cleanup);

describe('frozen env in initVarlockEnv', () => {
  it('frozen values win over the environment at boot, and process.env agrees', async () => {
    process.env.FZ_PUBLIC = 'boot-value';
    process.env.FZ_UNSET = 'boot-value-for-unset';
    process.env.__VARLOCK_ENV = makeFrozenBlob({
      FZ_PUBLIC: { value: 'frozen-value' },
      FZ_UNSET: { value: undefined },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();

    expect((envModule.ENV as any).FZ_PUBLIC).toBe('frozen-value');
    expect(process.env.FZ_PUBLIC).toBe('frozen-value');
    // unlike a build-baked `injectedAtBuild` blob, a frozen env is total
    expect(process.env.FZ_UNSET).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('FZ_PUBLIC, FZ_UNSET');
    expect(warn.mock.calls[0][0]).toContain('@dynamic=boot');
  });

  it('warns only once per process', async () => {
    process.env.FZ_PUBLIC = 'boot-value';
    process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_PUBLIC: { value: 'frozen-value' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    envModule.initVarlockEnv();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the boot value matches the frozen one', async () => {
    process.env.FZ_PUBLIC = 'same-value';
    process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_PUBLIC: { value: 'same-value' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not compare a sensitive value it cannot compare, but the frozen value still wins', async () => {
    process.env.FZ_SECRET = 'boot-secret';
    process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_SECRET: { value: 'frozen-secret', isSensitive: true } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envModule = await importFreshEnvModuleCopy();
    envModule.initVarlockEnv();
    expect(warn).not.toHaveBeenCalled();
    expect(process.env.FZ_SECRET).toBe('frozen-secret');
  });

  describe('@dynamic=boot items', () => {
    const portItem: BlobItem = { value: 3000, boot: { type: 'port', required: false } };

    it('applies a boot value when the frozen-env-boot bundle is loaded', async () => {
      process.env.FZ_PORT = '4123';
      process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_PORT: portItem });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await import('../frozen-env-boot');
      const envModule = await importFreshEnvModuleCopy();
      envModule.initVarlockEnv();

      expect((envModule.ENV as any).FZ_PORT).toBe(4123);
      expect(process.env.FZ_PORT).toBe('4123');
      // a boot item is meant to differ - never part of the conflict warning
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps the frozen default when no boot value is set', async () => {
      process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_PORT: portItem });
      await import('../frozen-env-boot');
      const envModule = await importFreshEnvModuleCopy();
      envModule.initVarlockEnv();
      expect((envModule.ENV as any).FZ_PORT).toBe(3000);
    });

    it('fails closed on an invalid boot value', async () => {
      process.env.FZ_PORT = 'not-a-port';
      process.env.__VARLOCK_ENV = makeFrozenBlob({ FZ_PORT: portItem });
      await import('../frozen-env-boot');
      const envModule = await importFreshEnvModuleCopy();
      expect(() => envModule.initVarlockEnv()).toThrow(/invalid @dynamic=boot value for the frozen env/);
    });
  });
});
