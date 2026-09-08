import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { resolveConfig } from 'vite';
import { decryptEnvBlobSync } from 'varlock/encrypt-env';

// mutable so individual tests can flip the decorator before importing the plugin
const mockState = vi.hoisted(() => ({ encryptInjectedEnv: true }));

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: vi.fn(() => ({
    stdout: JSON.stringify({
      basePath: '/fake-project',
      sources: [],
      settings: { encryptInjectedEnv: mockState.encryptInjectedEnv },
      config: {
        SECRET_KEY: { value: 'super-secret-value', isSensitive: true, isDynamic: true },
        PUBLIC_VAR: { value: 'public-value', isSensitive: false, isDynamic: false },
      },
    }),
    stderr: '',
  })),
  VarlockExecError: class VarlockExecError extends Error {
    stdout?: string;
    stderr?: string;
  },
}));

const TEST_KEY = 'ab'.repeat(32);
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

async function importPlugin() {
  vi.resetModules();
  return import('../src/index');
}

function findPlugin(plugins: Array<any>, name: string) {
  return plugins.find((plugin) => plugin.name === name);
}

function extractEncryptedBlob(code: string) {
  const match = code.match(/globalThis\.__varlockEncryptedEnv = "([^"]+)";/);
  if (!match) throw new Error('no encrypted blob in generated code');
  return match[1];
}

beforeEach(() => {
  vi.resetModules();
  mockState.encryptInjectedEnv = true;
  // the plugin writes process.env directly, which vi.unstubAllEnvs() does not undo
  delete process.env._VARLOCK_ENV_KEY;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env._VARLOCK_ENV_KEY;
});

describe('buildVarlockSsrInitCode() + @encryptInjectedEnv', () => {
  it('mints an ephemeral key before normal dev config hooks and encrypts with it', async () => {
    const { buildVarlockSsrInitCode, varlockVitePlugin } = await importPlugin();
    const observedEnv: Array<string | undefined> = [];

    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        ...varlockVitePlugin(),
        {
          name: 'dev-env-observer',
          config() { observedEnv.push(process.env._VARLOCK_ENV_KEY); },
        },
      ],
    }, 'serve');

    const mintedKey = process.env._VARLOCK_ENV_KEY;
    expect(mintedKey).toMatch(HEX_KEY_RE);
    expect(observedEnv).toEqual([mintedKey]);

    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: true });
    expect(code).toContain('globalThis.__varlockEncryptedEnv =');
    expect(code).not.toContain('super-secret-value');
    expect(code).not.toContain(mintedKey!);
    const decrypted = decryptEnvBlobSync(extractEncryptedBlob(code), mintedKey!);
    expect(decrypted).toContain('super-secret-value');
  });

  it('does not mint a key when @encryptInjectedEnv is off, and injects plaintext', async () => {
    mockState.encryptInjectedEnv = false;
    const { buildVarlockSsrInitCode, varlockVitePlugin } = await importPlugin();

    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: varlockVitePlugin(),
    }, 'serve');

    expect(process.env._VARLOCK_ENV_KEY).toBeUndefined();
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: true });
    expect(code).toContain('globalThis.__varlockLoadedEnv =');
    expect(code).not.toContain('__varlockEncryptedEnv =');
  });

  it('uses a key already present in the environment instead of minting one', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { buildVarlockSsrInitCode, varlockVitePlugin } = await importPlugin();

    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: varlockVitePlugin(),
    }, 'serve');

    expect(process.env._VARLOCK_ENV_KEY).toBe(TEST_KEY);
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: true });
    expect(code).toContain('varlock:v1:');
    const decrypted = decryptEnvBlobSync(extractEncryptedBlob(code), TEST_KEY);
    expect(decrypted).toContain('super-secret-value');
  });

  it('rejects the minted dev key at build time', async () => {
    const { buildVarlockSsrInitCode, varlockVitePlugin } = await importPlugin();
    await findPlugin(varlockVitePlugin(), 'varlock-dev-key-lifecycle').config(
      {},
      { command: 'serve', mode: 'development' },
    );
    expect(process.env._VARLOCK_ENV_KEY).toMatch(HEX_KEY_RE);

    expect(
      () => buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: false }),
    ).toThrow(/_VARLOCK_ENV_KEY is not set/);
  });

  it('encrypts at build time with a real key from the environment', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { buildVarlockSsrInitCode } = await importPlugin();
    const code = buildVarlockSsrInitCode({ ssrInjectMode: 'resolved-env', isDev: false });

    expect(code).toContain('globalThis.__varlockEncryptedEnv =');
    expect(code).toContain('varlock:v1:');
    expect(code).not.toContain('super-secret-value');
  });

  it('injects plaintext in dev on a cloudflare target even when a key is present', async () => {
    const { buildVarlockSsrInitCode, varlockVitePlugin } = await importPlugin();
    await findPlugin(varlockVitePlugin(), 'varlock-dev-key-lifecycle').config(
      {},
      { command: 'serve', mode: 'development' },
    );
    expect(process.env._VARLOCK_ENV_KEY).toMatch(HEX_KEY_RE);

    const code = buildVarlockSsrInitCode({
      ssrInjectMode: 'resolved-env',
      isDev: true,
      isCloudflareTarget: true,
    });
    expect(code).toContain('globalThis.__varlockLoadedEnv =');
    expect(code).not.toContain('__varlockEncryptedEnv =');
  });
});

describe('config hook - minted dev key', () => {
  it('does not expose a generated key to earlier build hooks', async () => {
    const { varlockVitePlugin } = await importPlugin();
    const observedEnv: Array<string | undefined> = [];

    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'early-build-env-observer',
          enforce: 'pre',
          config() { observedEnv.push(process.env._VARLOCK_ENV_KEY); },
        },
        ...varlockVitePlugin(),
      ],
    }, 'build');

    expect(observedEnv).toEqual([undefined]);
    expect(process.env._VARLOCK_ENV_KEY).toBeUndefined();
  });

  it('keeps the minted key for dev servers', async () => {
    const { varlockVitePlugin } = await importPlugin();
    const plugins = varlockVitePlugin();
    await findPlugin(plugins, 'varlock-dev-key-lifecycle').config(
      {},
      { command: 'serve', mode: 'development' },
    );
    const mintedKey = process.env._VARLOCK_ENV_KEY;

    await findPlugin(plugins, 'inject-varlock-config').config(
      {},
      { command: 'serve', mode: 'development' },
    );
    expect(process.env._VARLOCK_ENV_KEY).toBe(mintedKey);
  });

  it('leaves a user-provided key alone for builds', async () => {
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { varlockVitePlugin } = await importPlugin();
    const plugins = varlockVitePlugin();

    await findPlugin(plugins, 'varlock-dev-key-lifecycle').config(
      {},
      { command: 'build', mode: 'production' },
    );
    await findPlugin(plugins, 'inject-varlock-config').config(
      {},
      { command: 'build', mode: 'production' },
    );
    expect(process.env._VARLOCK_ENV_KEY).toBe(TEST_KEY);
  });
});

describe('config hook - reserved vars in vite `define`', () => {
  it('warns when a reserved varlock var is set via `define`', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { varlockVitePlugin } = await importPlugin();
    await findPlugin(varlockVitePlugin(), 'inject-varlock-config').config(
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
    await findPlugin(varlockVitePlugin(), 'inject-varlock-config').config(
      { define: { __MY_FLAG__: 'true' } },
      { command: 'serve', mode: 'development' },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
