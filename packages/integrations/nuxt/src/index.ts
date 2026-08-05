import { defineNuxtModule } from '@nuxt/kit';
import { varlockVitePlugin, type VarlockVitePluginOptions } from '@varlock/vite-integration';

export interface VarlockNuxtModuleOptions extends VarlockVitePluginOptions {}

export default defineNuxtModule<VarlockNuxtModuleOptions>({
  meta: {
    name: 'varlock',
    configKey: 'varlock',
    compatibility: {
      nuxt: '>=3.0.0',
    },
  },
  defaults: {},
  setup(moduleOptions, nuxt) {
    nuxt.hook('vite:extendConfig', (viteConfig) => {
      viteConfig.plugins ||= [];
      viteConfig.plugins.push(
        varlockVitePlugin({
          integrationTelemetry: {
            name: __VARLOCK_INTEGRATION_NAME__,
            version: __VARLOCK_INTEGRATION_VERSION__,
          },
          ...moduleOptions,
        }),
      );
    });
  },
});

declare const __VARLOCK_INTEGRATION_NAME__: string;
declare const __VARLOCK_INTEGRATION_VERSION__: string;
