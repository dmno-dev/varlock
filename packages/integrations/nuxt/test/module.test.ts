import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

const addVitePluginMock = vi.fn();
const defineNuxtModuleMock = vi.fn((moduleDef) => moduleDef);
const varlockVitePluginMock = vi.fn(() => ({ name: 'varlock-vite-plugin' }));

vi.mock('@nuxt/kit', () => ({
  addVitePlugin: addVitePluginMock,
  defineNuxtModule: defineNuxtModuleMock,
}));

vi.mock('@varlock/vite-integration', () => ({
  varlockVitePlugin: varlockVitePluginMock,
}));

describe('@varlock/nuxt module', () => {
  beforeEach(() => {
    addVitePluginMock.mockClear();
    defineNuxtModuleMock.mockClear();
    varlockVitePluginMock.mockClear();
    (globalThis as Record<string, unknown>).__VARLOCK_INTEGRATION_NAME__ = '@varlock/nuxt';
    (globalThis as Record<string, unknown>).__VARLOCK_INTEGRATION_VERSION__ = '0.0.1-test';
  });

  it('registers varlock Vite plugin via addVitePlugin and forwards options', async () => {
    type ModuleDef = {
      meta: { compatibility: { nuxt: string } },
      setup?: (...args: Array<unknown>) => void,
    };
    const { default: importedModule } = await import('../src/index');
    const nuxtModule = importedModule as unknown as ModuleDef;

    expect(nuxtModule.meta.compatibility.nuxt).toBe('>=3.0.0');

    nuxtModule.setup?.({ ssrInjectMode: 'auto-load' }, {});

    expect(addVitePluginMock).toHaveBeenCalledTimes(1);
    const pluginFactory = addVitePluginMock.mock.calls[0][0] as () => unknown;
    pluginFactory();
    expect(varlockVitePluginMock).toHaveBeenCalledWith(expect.objectContaining({
      ssrInjectMode: 'auto-load',
      integrationTelemetry: {
        name: '@varlock/nuxt',
        version: '0.0.1-test',
      },
    }));
  });
});
