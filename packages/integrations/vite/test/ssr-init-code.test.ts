import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const FAKE_GRAPH = {
  basePath: '/fake-project',
  sources: [],
  settings: { encryptInjectedEnv: true },
  config: {
    SECRET_KEY: { value: 'super-secret-value', isSensitive: true, isDynamic: true },
    PUBLIC_VAR: { value: 'public-value', isSensitive: false, isDynamic: false },
  },
};

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: vi.fn(() => ({ stdout: JSON.stringify(FAKE_GRAPH), stderr: '' })),
  VarlockExecError: class VarlockExecError extends Error {
    stdout?: string;
    stderr?: string;
  },
}));

const TEST_KEY = 'ab'.repeat(32);

async function importPlugin() {
  vi.resetModules();
  return import('../src/index');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildVarlockSsrInitCode() + @encryptInjectedEnv', () => {
  it('injects plaintext in dev when no key is set, and does not mint one', async () => {
    const { buildVarlockSsrInitCode } = await importPlugin();
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: true });

    expect(code).toContain('globalThis.__varlockLoadedEnv =');
    expect(code).not.toContain('__varlockEncryptedEnv =');
    // regression guard: the old code minted a key here and wrote it to process.env,
    // where worker-based dev runtimes (nitro, vitest pools, miniflare) never see it
    expect(process.env._VARLOCK_ENV_KEY).toBeUndefined();
  });

  it('encrypts in dev when a key is present in the environment', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { buildVarlockSsrInitCode } = await importPlugin();
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: true });

    expect(code).toContain('globalThis.__varlockEncryptedEnv =');
    expect(code).toContain('varlock:v1:');
    expect(code).not.toContain('super-secret-value');
  });

  it('throws at build time when no key is set', async () => {
    const { buildVarlockSsrInitCode } = await importPlugin();
    expect(
      () => buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: false }),
    ).toThrow(/_VARLOCK_ENV_KEY is not set/);
  });

  it('injects plaintext in dev on a cloudflare target even when a key is present', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { buildVarlockSsrInitCode } = await importPlugin();
    const code = buildVarlockSsrInitCode({
      ssrInjectMode: 'resolved-env',
      isDev: true,
      isCloudflareTarget: true,
    });

    expect(code).toContain('globalThis.__varlockLoadedEnv =');
    expect(code).not.toContain('__varlockEncryptedEnv =');
  });

  it('encrypts at build time when a key is present', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { buildVarlockSsrInitCode } = await importPlugin();
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: false });

    expect(code).toContain('globalThis.__varlockEncryptedEnv =');
    expect(code).toContain('varlock:v1:');
    expect(code).not.toContain('super-secret-value');
  });
});

describe('config hook - reserved vars in vite `define`', () => {
  it('warns when a reserved varlock var is set via `define`', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { varlockVitePlugin } = await importPlugin();
    await varlockVitePlugin().config(
      { define: { _VARLOCK_ENV_KEY: 'abc' } },
      { command: 'serve', mode: 'development' },
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnings.some((msg) => msg.includes('_VARLOCK_ENV_KEY'))).toBe(true);
    expect(warnings.some((msg) => msg.includes('define'))).toBe(true);
  });

  it('does not warn for a define without reserved keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { varlockVitePlugin } = await importPlugin();
    await varlockVitePlugin().config(
      { define: { __MY_FLAG__: 'true' } },
      { command: 'serve', mode: 'development' },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
