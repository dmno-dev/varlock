import {
  addTemplate, addServerPlugin, addVitePlugin, defineNuxtModule,
} from '@nuxt/kit';
import type { NuxtModule } from '@nuxt/schema';
import {
  buildVarlockSsrInitCode, varlockVitePlugin, type VarlockVitePluginOptions,
} from '@varlock/vite-integration';

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
  setup(moduleOptions, nuxt) {
    addVitePlugin(() => varlockVitePlugin({
      integrationTelemetry: {
        name: __VARLOCK_INTEGRATION_NAME__,
        version: __VARLOCK_INTEGRATION_VERSION__,
      },
      // Nuxt points vite's `root` at the srcDir (`app/` by default in Nuxt 4),
      // but `.env.schema` and `.env` files live at the project root. Without
      // this the plugin reloads varlock from the srcDir, finds no schema, and
      // silently drops every build-time `ENV.*` replacement.
      rootDir: nuxt.options.rootDir,
      ...moduleOptions,
    }));

    // Nitro builds the production server with its own rollup pass, so the init
    // module injected into vite's SSR entry never reaches `.output/server` —
    // and server routes (`server/api/**`) are never part of the vite SSR graph
    // at all. Register the same init sequence as a Nitro plugin so `ENV` is
    // initialized and the console/response patches (log redaction and leak
    // prevention) are installed before any request is handled.
    const initTemplate = addTemplate({
      filename: 'varlock-nitro-init.mjs',
      write: true,
      getContents: () => [
        buildVarlockSsrInitCode({
          ...moduleOptions,
          // this runs before the vite plugin's `config` hook, so the plugin has
          // not corrected the load directory yet — `nuxt build --cwd ./app`
          // would otherwise bake an empty env into a `resolved-env` build
          rootDir: nuxt.options.rootDir,
          isDev: nuxt.options.dev,
          preserveSideEffectImports: true,
        }),
        // Nitro plugins must default-export a function. The init above runs as
        // a module side effect, which happens on import — earlier than the
        // plugin call, and earlier than any lazily-imported route handler.
        'export default () => {};',
      ].join('\n'),
    });
    addServerPlugin(initTemplate.dst);
  },
});

export default varlockNuxtModule;
