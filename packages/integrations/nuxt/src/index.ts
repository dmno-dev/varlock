import { addVitePlugin, defineNuxtModule } from '@nuxt/kit';
import type { NuxtModule } from '@nuxt/schema';
import { varlockVitePlugin, type VarlockVitePluginOptions } from '@varlock/vite-integration';

declare const __VARLOCK_INTEGRATION_NAME__: string;
declare const __VARLOCK_INTEGRATION_VERSION__: string;

export interface VarlockNuxtModuleOptions extends VarlockVitePluginOptions {}

const varlockNuxtModule: NuxtModule<VarlockNuxtModuleOptions> = defineNuxtModule<VarlockNuxtModuleOptions>({
  meta: {
    name: 'varlock',
    configKey: 'varlock',
    compatibility: {
      nuxt: '>=3.0.0',
    },
  },
  defaults: {},
  setup(moduleOptions) {
    addVitePlugin(() => varlockVitePlugin({
      integrationTelemetry: {
        name: __VARLOCK_INTEGRATION_NAME__,
        version: __VARLOCK_INTEGRATION_VERSION__,
      },
      ...moduleOptions,
    }));
  },
});

export default varlockNuxtModule;
