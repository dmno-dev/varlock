import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import pkg from '../package.json';

const addVitePluginMock = vi.fn();
const addServerPluginMock = vi.fn();
const addTemplateMock = vi.fn((template) => ({ ...template, dst: `/fake-buildDir/${template.filename}` }));
const defineNuxtModuleMock = vi.fn((moduleDef) => moduleDef);
const varlockVitePluginMock = vi.fn(() => ({ name: 'varlock-vite-plugin' }));
const buildVarlockSsrInitCodeMock = vi.fn(() => 'initVarlockEnv();');

vi.mock('@nuxt/kit', () => ({
  addServerPlugin: addServerPluginMock,
  addTemplate: addTemplateMock,
  addVitePlugin: addVitePluginMock,
  defineNuxtModule: defineNuxtModuleMock,
}));

vi.mock('@varlock/vite-integration', () => ({
  buildVarlockSsrInitCode: buildVarlockSsrInitCodeMock,
  varlockVitePlugin: varlockVitePluginMock,
}));

type ModuleDef = {
  meta: { compatibility: { nuxt: string } },
  setup?: (...args: Array<unknown>) => void,
};

const FAKE_NUXT = { options: { rootDir: '/fake-project', dev: false } };

async function loadModule() {
  const { default: importedModule } = await import('../src/index');
  return importedModule as unknown as ModuleDef;
}

describe('@varlock/nuxt module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares compatibility with nuxt 3 and up', async () => {
    const nuxtModule = await loadModule();
    expect(nuxtModule.meta.compatibility.nuxt).toBe('>=3.0.0');
  });

  it('registers the varlock vite plugin and forwards options', async () => {
    const nuxtModule = await loadModule();
    nuxtModule.setup?.({ ssrInjectMode: 'auto-load' }, FAKE_NUXT);

    expect(addVitePluginMock).toHaveBeenCalledTimes(1);
    const pluginFactory = addVitePluginMock.mock.calls[0][0] as () => unknown;
    pluginFactory();
    expect(varlockVitePluginMock).toHaveBeenCalledWith(expect.objectContaining({
      ssrInjectMode: 'auto-load',
      integrationTelemetry: {
        name: pkg.name,
        version: pkg.version,
      },
    }));
  });

  // Nuxt points vite's `root` at the srcDir (`app/` in Nuxt 4), but env files
  // live at the project root — without this the plugin loads an empty config
  // and silently drops every build-time `ENV.*` replacement.
  it('passes the nuxt rootDir through to the vite plugin', async () => {
    const nuxtModule = await loadModule();
    nuxtModule.setup?.({}, FAKE_NUXT);

    (addVitePluginMock.mock.calls[0][0] as () => unknown)();
    expect(varlockVitePluginMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: '/fake-project',
    }));
  });

  // Nitro rebuilds the server with its own rollup pass, so the init injected
  // into vite's SSR entry never reaches `.output/server`.
  it('registers a nitro plugin carrying the varlock init code', async () => {
    const nuxtModule = await loadModule();
    nuxtModule.setup?.({ ssrInjectMode: 'resolved-env' }, FAKE_NUXT);

    expect(addTemplateMock).toHaveBeenCalledTimes(1);
    const template = addTemplateMock.mock.calls[0][0];
    expect(template.filename).toBe('varlock-nitro-init.mjs');
    expect(template.write).toBe(true);

    const contents = template.getContents();
    expect(buildVarlockSsrInitCodeMock).toHaveBeenCalledWith(expect.objectContaining({
      ssrInjectMode: 'resolved-env',
      isDev: false,
      // this runs before the vite plugin's `config` hook, so without an
      // explicit rootDir a `nuxt build --cwd ./app` bakes an empty env
      rootDir: '/fake-project',
      // nitro's rollup drops bare side-effect imports of externals
      preserveSideEffectImports: true,
    }));
    expect(contents).toContain('initVarlockEnv();');
    // nitro requires plugins to default-export a function
    expect(contents).toContain('export default () => {};');

    expect(addServerPluginMock).toHaveBeenCalledWith('/fake-buildDir/varlock-nitro-init.mjs');
  });
});
