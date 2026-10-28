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

// `@varlock/cloudflare-integration` is loaded lazily and is not a dependency of this package
vi.mock('@varlock/cloudflare-integration/ssr-entry-code', () => ({
  CLOUDFLARE_SSR_ENTRY_CODE: '/* cloudflare edge env loader */',
}));

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

  async function initModuleCode(options: Record<string, any>, otherPlugins: Array<any> = []) {
    const { varlockVitePlugin } = await importPlugin();
    const resolved = await resolveConfig({
      configFile: false,
      logLevel: 'silent',
      plugins: [...varlockVitePlugin(), ...otherPlugins, sveltekitSetup(options)],
    }, 'build');
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
    expect(buildVarlockSsrInitCode({ isDev: true })).toContain(exposed);
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
