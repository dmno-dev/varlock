import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig } from 'vite';
import { decryptEnvBlobSync } from 'varlock/encrypt-env';
import { hashEnvSourceContents } from 'varlock/env-source-fingerprint';

// mutable so individual tests can flip the decorator before importing the plugin
const mockState = vi.hoisted(() => ({
  encryptInjectedEnv: true,
  publicValue: 'public-value',
  loads: 0,
  basePath: '/fake-project',
  sources: [] as Array<{ enabled: boolean, path: string }>,
  absentSourcePaths: undefined as Array<string> | undefined,
  failNextLoad: false,
  // set below from the real helper - mocks are hoisted above imports
  hashFile: undefined as undefined | ((absPath: string) => string | undefined),
}));

vi.mock('varlock/exec-sync-varlock', () => {
  class VarlockExecError extends Error {
    stdout?: string;
    stderr?: string;
  }
  return {
    execSyncVarlock: vi.fn(() => {
      mockState.loads++;
      const stdout = JSON.stringify({
        basePath: mockState.basePath,
        // like a real load: fingerprint what each file source contained at load time
        sources: mockState.sources.map((source) => ({
          ...source,
          contentHash: mockState.hashFile?.(`${mockState.basePath}/${source.path}`),
        })),
        absentSourcePaths: mockState.absentSourcePaths,
        settings: { encryptInjectedEnv: mockState.encryptInjectedEnv },
        config: {
          SECRET_KEY: { value: 'super-secret-value', isSensitive: true, isDynamic: true },
          PUBLIC_VAR: { value: mockState.publicValue, isSensitive: false, isDynamic: false },
        },
      });
      if (mockState.failNextLoad) {
        mockState.failNextLoad = false;
        const err = new VarlockExecError('load failed');
        err.stdout = stdout;
        err.stderr = 'resolver failed';
        throw err;
      }
      return { stdout, stderr: '' };
    }),
    VarlockExecError,
  };
});

// `@varlock/cloudflare-integration` is loaded lazily and is not a dependency of this package
vi.mock('@varlock/cloudflare-integration/ssr-entry-code', () => ({
  CLOUDFLARE_SSR_ENTRY_CODE: '/* cloudflare edge env loader */',
}));

mockState.hashFile = (absPath) => {
  try {
    return hashEnvSourceContents(readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
};

// warm the module graph (plugin + varlock source) at collection time, so the
// transform cost is not charged against the first test's timeout
await import('../src/index');

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
  mockState.publicValue = 'public-value';
  mockState.basePath = '/fake-project';
  mockState.sources = [];
  mockState.absentSourcePaths = undefined;
  mockState.failNextLoad = false;
  delete (globalThis as any).__varlockLoadedEnv;
  // the plugin writes process.env directly, which vi.unstubAllEnvs() does not undo
  delete process.env._VARLOCK_ENV_KEY;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env._VARLOCK_ENV_KEY;
  delete process.env.__VARLOCK_EXECUTION_PHASE;
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

  it('does not mint a key for `vite preview`', async () => {
    const { varlockVitePlugin } = await importPlugin();
    // preview serves a finished build that was encrypted with a real key; a
    // minted key would only turn "key is not set" into a decrypt failure
    await findPlugin(varlockVitePlugin(), 'varlock-dev-key-lifecycle').config(
      {},
      { command: 'serve', mode: 'production', isPreview: true },
    );
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

describe('env freshness across dev restarts', () => {
  // a temp project with a real schema file, so the env-file fingerprint has
  // something to compare. It is never the cwd, which the module-level load uses.
  let appRoot: string;
  beforeEach(() => {
    appRoot = mkdtempSync(path.join(tmpdir(), 'varlock-vite-fresh-'));
    writeFileSync(path.join(appRoot, '.env.schema'), 'PUBLIC_VAR=first\n');
    mockState.basePath = appRoot;
    mockState.sources = [{ enabled: true, path: '.env.schema' }];
    mockState.absentSourcePaths = ['.env', '.env.local'];
    return () => rmSync(appRoot, { recursive: true, force: true });
  });

  // a resolver output and the file it comes from change together
  function editSchema(value: string) {
    writeFileSync(path.join(appRoot, '.env.schema'), `PUBLIC_VAR=${value}\n# edited\n`);
    mockState.publicValue = value;
  }

  // a restart resolves the config again with new plugin instances, while this
  // module stays cached, so only the config hook can reload the env
  async function resolveDevConfig(plugins: Array<any>, root?: string) {
    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins,
    }, 'serve');
  }

  it('reuses the loaded env on a restart when no env file changed', async () => {
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
    mockState.publicValue = 'first';
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    const loadsBefore = mockState.loads;

    // a resolver whose output changes on its own (exec(), a remote secret) is
    // not re-run just because the dev server restarted
    mockState.publicValue = 'changed-remotely';
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    expect(mockState.loads - loadsBefore).toBe(0);
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('first');
  });

  it('reloads once per restart after a loaded env file changes', async () => {
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
    mockState.publicValue = 'first';
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    const loadsBefore = mockState.loads;

    for (const value of ['second', 'third']) {
      editSchema(value);
      await resolveDevConfig(varlockVitePlugin(), appRoot);
      expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe(value);
    }
    expect(mockState.loads - loadsBefore).toBe(2);
  });

  it('reloads on a restart after an env file a load would pick up is created', async () => {
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    const loadsBefore = mockState.loads;

    writeFileSync(path.join(appRoot, '.env.local'), 'PUBLIC_VAR=from-local\n');
    mockState.publicValue = 'from-local';
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    expect(mockState.loads - loadsBefore).toBe(1);
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('from-local');
  });

  it('does not reload when an env-like file varlock never loads appears', async () => {
    const { varlockVitePlugin } = await importPlugin();
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    const loadsBefore = mockState.loads;

    writeFileSync(path.join(appRoot, '.env.example'), 'PUBLIC_VAR=example\n');
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    expect(mockState.loads - loadsBefore).toBe(0);
  });

  it('retries on a restart when the previous load failed, even with no file change', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
    mockState.failNextLoad = true;
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    const loadsBefore = mockState.loads;

    mockState.publicValue = 'recovered';
    await resolveDevConfig(varlockVitePlugin(), appRoot);
    expect(mockState.loads - loadsBefore).toBe(1);
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('recovered');
  });

  it('loads once per change with `rootDir` when the dev-key hook loads first', async () => {
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
    const loadsBefore = mockState.loads;

    mockState.publicValue = 'first';
    await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
    for (const value of ['second', 'third']) {
      editSchema(value);
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe(value);
    }
    expect(mockState.loads - loadsBefore).toBe(3);
  });

  it('reloads on the first restart after a change with `rootDir` and a key already in the environment', async () => {
    // with a key set, the dev-key lifecycle hook does not load `rootDir` first
    vi.stubEnv('_VARLOCK_ENV_KEY', TEST_KEY);
    const { getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();

    mockState.publicValue = 'first';
    await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('first');

    editSchema('second');
    await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('second');
  });

  describe('ensureVarlockEnvFresh() (integration-driven reloads, e.g. nuxt)', () => {
    it('does nothing when no env file changed (shutdown, config-only reload)', async () => {
      const { ensureVarlockEnvFresh, getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
      mockState.publicValue = 'first';
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      const loadsBefore = mockState.loads;

      mockState.publicValue = 'changed-remotely';
      ensureVarlockEnvFresh(appRoot);
      // a config-only reload: the replacement instance resolves vite again,
      // and must see the same snapshot its config was evaluated against
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      expect(mockState.loads - loadsBefore).toBe(0);
      expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('first');
    });

    it('reloads after a change, and the next vite resolve reuses that load', async () => {
      const { ensureVarlockEnvFresh, getVarlockLoadedEnv, varlockVitePlugin } = await importPlugin();
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      const loadsBefore = mockState.loads;

      editSchema('refreshed');
      ensureVarlockEnvFresh(appRoot);
      expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('refreshed');
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      expect(mockState.loads - loadsBefore).toBe(1);
    });

    it('is idempotent: a second call for the same change does not reload', async () => {
      const { ensureVarlockEnvFresh, varlockVitePlugin } = await importPlugin();
      await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
      const loadsBefore = mockState.loads;

      editSchema('refreshed');
      // nuxt fires both `restart` and `close` for one hook-driven restart
      ensureVarlockEnvFresh(appRoot);
      ensureVarlockEnvFresh(appRoot);
      expect(mockState.loads - loadsBefore).toBe(1);
    });

    it('reloads when asked for a different root than the loaded one', async () => {
      const { ensureVarlockEnvFresh } = await importPlugin();
      const loadsBefore = mockState.loads;
      ensureVarlockEnvFresh(appRoot);
      expect(mockState.loads - loadsBefore).toBe(1);
    });
  });

  it('refreshVarlockEnv() still forces a reload, and the next resolve reuses it', async () => {
    const { getVarlockLoadedEnv, refreshVarlockEnv, varlockVitePlugin } = await importPlugin();
    await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
    const loadsBefore = mockState.loads;

    mockState.publicValue = 'refreshed';
    refreshVarlockEnv(appRoot);
    await resolveDevConfig(varlockVitePlugin({ rootDir: appRoot }));
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('refreshed');
    expect(mockState.loads - loadsBefore).toBe(1);
  });

  it('does not reload on a build when the root matches the loaded config', async () => {
    const { varlockVitePlugin } = await importPlugin();
    const loadsBefore = mockState.loads;

    await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      root: process.cwd(),
      plugins: varlockVitePlugin(),
    }, 'build');
    expect(mockState.loads - loadsBefore).toBe(0);
  });
});

describe('startup loads', () => {
  it('adopts an env graph varlock/auto-load already resolved in this process', async () => {
    // e.g. `import 'varlock/auto-load'` at the top of nuxt.config / vite.config
    const autoLoadedGraph = {
      basePath: process.cwd(),
      sources: [],
      settings: {},
      config: { PUBLIC_VAR: { value: 'from-auto-load', isSensitive: false, isDynamic: false } },
    };
    (globalThis as any).__varlockLoadedEnv = autoLoadedGraph;
    const loadsBefore = mockState.loads;
    const { getVarlockLoadedEnv } = await importPlugin();
    expect(mockState.loads - loadsBefore).toBe(0);
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('from-auto-load');
  });

  it('does not adopt an auto-loaded graph from a different directory', async () => {
    (globalThis as any).__varlockLoadedEnv = {
      basePath: '/some/other/project', sources: [], settings: {}, config: {},
    };
    const loadsBefore = mockState.loads;
    const { getVarlockLoadedEnv } = await importPlugin();
    expect(mockState.loads - loadsBefore).toBe(1);
    expect(getVarlockLoadedEnv()?.config.PUBLIC_VAR?.value).toBe('public-value');
  });

  it('resolves at import when nothing has been loaded yet', async () => {
    const loadsBefore = mockState.loads;
    await importPlugin();
    expect(mockState.loads - loadsBefore).toBe(1);
  });

  it('does not reload just because an integration passes its telemetry name', async () => {
    const { varlockVitePlugin } = await importPlugin();
    const loadsBefore = mockState.loads;
    varlockVitePlugin({ integrationTelemetry: { name: '@varlock/some-integration', version: '1.0.0' } });
    expect(mockState.loads - loadsBefore).toBe(0);
  });
});

describe('transformIndexHtml + SvelteKit', () => {
  // SvelteKit warns about any resolved plugin with `transformIndexHtml` (#1177)
  async function resolvedHasHtmlHook(extraPlugins: Array<any>) {
    const { varlockVitePlugin } = await importPlugin();
    const resolved = await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: [...varlockVitePlugin(), ...extraPlugins],
    }, 'serve');
    return !!findPlugin(resolved.plugins as Array<any>, 'inject-varlock-config').transformIndexHtml;
  }

  it('keeps the hook in non-SvelteKit projects', async () => {
    expect(await resolvedHasHtmlHook([])).toBe(true);
  });

  it('drops the hook when SvelteKit plugins are present (async plugin array)', async () => {
    const fakeSvelteKit = Promise.resolve([{ name: 'vite-plugin-sveltekit-setup' }]);
    expect(await resolvedHasHtmlHook([fakeSvelteKit])).toBe(false);
  });
});

describe('SvelteKit Cloudflare adapter detection', () => {
  // SvelteKit 2 nests its resolved config under `kit`, SvelteKit 3 flattened it
  const sveltekitSetup = (options: Record<string, any>) => ({
    name: 'vite-plugin-sveltekit-setup',
    api: { options },
  });

  async function initModuleCode(
    options: Record<string, any>,
    otherPlugins: Array<any> = [],
    command: 'build' | 'serve' = 'build',
  ) {
    const { varlockVitePlugin } = await importPlugin();
    const resolved = await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: [...varlockVitePlugin(), ...otherPlugins, sveltekitSetup(options)],
    }, command);
    const plugin = findPlugin(resolved.plugins as Array<any>, 'inject-varlock-config');
    return plugin.load.call({ environment: { name: 'ssr' } }, '\0varlock-ssr-init') as string;
  }

  it('injects the edge env loader for the SvelteKit 2 config shape', async () => {
    const code = await initModuleCode({ kit: { adapter: { name: '@sveltejs/adapter-cloudflare' } } });
    expect(code).toContain('/* cloudflare edge env loader */');
  });

  it('injects the edge env loader for the SvelteKit 3 config shape', async () => {
    const code = await initModuleCode({ adapter: { name: '@sveltejs/adapter-cloudflare' } });
    expect(code).toContain('/* cloudflare edge env loader */');
  });

  it('skips the edge env loader in `vite dev`, where SSR runs in Node', async () => {
    const adapter = { name: '@sveltejs/adapter-cloudflare' };
    expect(await initModuleCode({ adapter }, [], 'serve')).not.toContain('cloudflare edge env loader');
    expect(await initModuleCode({ kit: { adapter } }, [], 'serve')).not.toContain('cloudflare edge env loader');
  });

  it('leaves other adapters alone, in both config shapes', async () => {
    const nodeAdapter = { name: '@sveltejs/adapter-node' };
    expect(await initModuleCode({ kit: { adapter: nodeAdapter } })).not.toContain('cloudflare edge env loader');
    expect(await initModuleCode({ adapter: nodeAdapter })).not.toContain('cloudflare edge env loader');
  });

  it('is not shadowed by another plugin exposing a top-level adapter', async () => {
    const otherPlugin = { name: 'some-other-plugin', api: { options: { adapter: { name: 'something-else' } } } };
    const code = await initModuleCode({ adapter: { name: '@sveltejs/adapter-cloudflare' } }, [otherPlugin]);
    expect(code).toContain('/* cloudflare edge env loader */');
  });

  it('treats adapter-auto as Cloudflare in Workers CI, in the SvelteKit 3 shape', async () => {
    vi.stubEnv('WORKERS_CI', '1');
    try {
      const code = await initModuleCode({ adapter: { name: '@sveltejs/adapter-auto' } });
      expect(code).toContain('/* cloudflare edge env loader */');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// the re-patch tests drive the real console.log on purpose
/* eslint-disable no-console */
describe('RSC dev console replay re-patch', () => {
  // mirrors react-server-dom-*-server.*.development.js: at load it wraps the console methods
  // with a wrapper that captures the call args (there: serializes them into the flight
  // stream) before calling through
  const reactDevConsolePatch = 'function patchConsole(c, m) { var orig = c[m]; var w = function () { __captured.push(Array.from(arguments)); return orig.apply(this, arguments); }; Object.defineProperty(c, m, { value: w }); }\n'
    + '"object" === typeof console && null !== console && (patchConsole(console, "assert"), patchConsole(console, "log"));\n';
  const REPATCH = 'if(globalThis.__varlockPatchConsole)globalThis.__varlockPatchConsole();';
  const SECRET = 'super-secret-value';

  async function transformWith(code: string, id: string, opts?: { ssr?: boolean }) {
    const { varlockVitePlugin } = await importPlugin();
    const plugin = varlockVitePlugin().find((p: any) => typeof p.transform === 'function');
    const ctx = {
      environment: { mode: 'dev' },
      getModuleInfo: () => ({ isEntry: false }),
      getModuleIds: () => ['/fake-project/src/entry.ts'],
    };
    return plugin.transform.call(ctx, code, id, opts);
  }

  // stand-in for varlock's console patch: wraps console.log with a redacting layer, the way
  // patchGlobalConsole() does once the init module has run
  function installStubConsolePatch() {
    const g = globalThis as any;
    const originalLog = console.log;
    const captured: Array<Array<unknown>> = [];
    g.__varlockPatchConsole = () => {
      const inner = console.log;
      console.log = function patchedFn(this: unknown, ...args: Array<unknown>) {
        return inner.apply(this, args.map((a) => (typeof a === 'string' ? a.replaceAll(SECRET, '[redacted]') : a)));
      };
    };
    g.__varlockPatchConsole();
    return {
      captured,
      // eslint-disable-next-line no-new-func
      run: (code: string) => new Function('__captured', code)(captured),
      restore: () => {
        console.log = originalLog;
        delete g.__varlockPatchConsole;
      },
    };
  }

  it('exposes the console patch on globalThis from the init module, in every inject mode', async () => {
    const { buildVarlockSsrInitCode } = await importPlugin();
    const exposed = 'globalThis.__varlockPatchConsole = __varlockPatchConsole.patchGlobalConsole;';
    // init-only / resolved-env: initVarlockRuntime() sets the global itself
    expect(buildVarlockSsrInitCode({ isDev: true })).toContain('initVarlockRuntime();');
    expect(buildVarlockSsrInitCode({ isDev: true, ssrInjectMode: 'auto-load' })).toContain(exposed);
    expect(buildVarlockSsrInitCode({ isDev: true, ssrInjectMode: 'auto-load', preserveSideEffectImports: true })).toContain(exposed);
  });

  it('inserts the re-patch right after the statement that installs the React wrapper', async () => {
    const id = '/fake-project/node_modules/react-server-dom-webpack/cjs/react-server-dom-webpack-server.edge.development.js';
    const code = `${reactDevConsolePatch}var after = 1;\n`;
    const result = await transformWith(code, id, { ssr: true });
    expect(result?.code).toContain(`patchConsole(console, "log"));\n${REPATCH}\n\nvar after = 1;`);
  });

  it('React receives redacted args once its module has evaluated', async () => {
    const id = '/fake-project/node_modules/.vite/deps_rsc/react-server-dom-webpack-server.edge.development-abc.js';
    const result = await transformWith(reactDevConsolePatch, id, { ssr: true });
    const h = installStubConsolePatch();
    try {
      h.run(result!.code);
      console.log(`value: ${SECRET}`);
      expect(h.captured).toEqual([['value: [redacted]']]);
    } finally {
      h.restore();
    }
  });

  it('still re-patches when the body sits in a shared lazy factory run later by another module', async () => {
    // the dep optimizer wraps the CommonJS body in a `require_*` factory; when something else
    // also requires server.edge the factory lands in a shared chunk and only runs when an
    // untransformed facade elsewhere calls it, long after the chunk itself evaluated
    const chunkCode = `var require_server_edge = __commonJSMin(function (exports) {\n${
      reactDevConsolePatch
    }exports.renderToReadableStream = function () {};\n`
      + '});\n';
    const id = '/fake-project/node_modules/.vite/deps_rsc/chunk-SHARED.js';
    const result = await transformWith(chunkCode, id, { ssr: true });
    const h = installStubConsolePatch();
    try {
      // the chunk evaluates (defining the factory), then the facade calls it
      h.run(`globalThis.__commonJSMin = function (fn) { var cached; return function () { if (!cached) { cached = {}; fn(cached); } return cached; }; };\n${
        result!.code
      }globalThis.__facade = function () { return require_server_edge(); };\n`);
      expect(h.captured).toEqual([]);
      (globalThis as any).__facade();
      console.log(`value: ${SECRET}`);
      expect(h.captured).toEqual([['value: [redacted]']]);
    } finally {
      h.restore();
      delete (globalThis as any).__commonJSMin;
      delete (globalThis as any).__facade;
    }
  });

  it('leaves the production React build and client modules alone', async () => {
    const prodId = '/fake-project/node_modules/react-server-dom-webpack/cjs/react-server-dom-webpack-server.edge.production.js';
    const prodResult = await transformWith('export const renderToReadableStream = () => {};\n', prodId, { ssr: true });
    expect(prodResult?.code ?? '').not.toContain(REPATCH);

    const clientId = '/fake-project/node_modules/.vite/deps/react-server-dom-webpack-client.browser.development.js';
    const clientResult = await transformWith(reactDevConsolePatch, clientId, { ssr: false });
    expect(clientResult?.code ?? '').not.toContain(REPATCH);
  });
});
