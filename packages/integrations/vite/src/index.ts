/* eslint-disable no-console */

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Plugin } from 'vite';
import Debug from 'debug';
import MagicString from 'magic-string';

import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';
import { SerializedEnvGraph } from 'varlock';

import { createReplacerTransformFn } from './transform';

// enables throwing when user accesses a bad key on ENV
(globalThis as any).__varlockThrowOnMissingKeys = true;

// need to track original process.env, since we will be modifying it
const originalProcessEnv = { ...process.env };

const debug = Debug('varlock:vite-integration');

let isFirstLoad = !(process as any).__VARLOCK_ENV;

debug('varlock vite plugin loaded. first load = ', isFirstLoad);

let isDevMode: boolean;
let configIsValid = true;
export let varlockLoadedEnv: SerializedEnvGraph;
let staticReplacements: Record<string, any> = {};
let replacerFn: ReturnType<typeof createReplacerTransformFn>;

const DETECT_PRESETS_USING_PLUGINS = {
  'vite-plugin-cloudflare': 'cloudflare-workers',
} as const;

let detectedPreset: typeof DETECT_PRESETS_USING_PLUGINS[keyof typeof DETECT_PRESETS_USING_PLUGINS] | null = null;

function resetStaticReplacements() {
  staticReplacements = {};
  for (const itemKey in varlockLoadedEnv?.config) {
    const itemInfo = varlockLoadedEnv.config[itemKey];
    // TODO: probably reimplement static/dynamic controls here too
    if (!itemInfo.isSensitive) {
      const val = JSON.stringify(itemInfo.value);
      staticReplacements[`ENV.${itemKey}`] = val;
    }
  }

  debug('static replacements', staticReplacements);

  replacerFn = createReplacerTransformFn({
    replacements: staticReplacements,
  });
}


let loadCount = 0;
function reloadConfig() {
  debug('loading config - count =', ++loadCount);
  try {
    const execResult = execSync('varlock load --format json-full', { env: originalProcessEnv });
    process.env.__VARLOCK_ENV = execResult.toString();
    varlockLoadedEnv = JSON.parse(process.env.__VARLOCK_ENV) as SerializedEnvGraph;
    configIsValid = true;
  } catch (err) {
    const errResult = err as ReturnType<typeof spawnSync>;
    configIsValid = false;
    console.log(errResult.stdout.toString());
  }

  // initialize varlock and patch globals as necessary
  initVarlockEnv();
  // these will be no-ops if these are disabled by settings
  patchGlobalConsole();
  patchGlobalServerResponse();
  patchGlobalResponse();

  resetStaticReplacements();
}

// we run this right away so the globals get injected into the vite.config file
reloadConfig();

export function varlockVitePlugin(
  vitePluginOptions?: {
    /** controls if/how varlock init code is injected into the built SSR application code */
    ssrInjectMode?: 'auto-load' | 'init-only' | 'resolved-env',
  }, // TODO: add options? like allow injecting sensitive config?
): Plugin {
  return {
    name: 'inject-varlock-config',
    enforce: 'post',

    // hook to modify config before it is resolved
    async config(config, env) {
      debug('vite plugin - config fn called');

      isDevMode = env.command === 'serve';

      const allPlugins = config.plugins?.flatMap((p) => p);
      allPlugins?.forEach((p) => {
        if (p && 'name' in p && p.name in DETECT_PRESETS_USING_PLUGINS) {
          detectedPreset = DETECT_PRESETS_USING_PLUGINS[p.name as keyof typeof DETECT_PRESETS_USING_PLUGINS];
        }
      });

      // we do not want to inject via config.define - instead we use @rollup/plugin-replace

      if (!configIsValid) {
        if (isDevMode) {
          // adjust vite's setting so it doesnt bury the error messages
          config.clearScreen = false;
        } else {
          console.log('💥 Varlock config validation failed 💥');
          // throwing an error spits out a big useless stack trace... so better to just exit?
          process.exit(1);
        }
      }
    },
    // hook to observe/modify config after it is resolved
    configResolved(config) {
      debug('vite plugin - configResolved fn called');
      // inject all .env files that varlock loaded into `configFileDependencies`
      // so that vite will watch them and reload if they change
      for (const varlockSource of varlockLoadedEnv.sources) {
        if (!varlockSource.enabled) continue;
        if (varlockLoadedEnv.basePath && varlockSource.path) {
          config.configFileDependencies.push(path.resolve(varlockLoadedEnv.basePath, varlockSource.path));
        }
      }
    },
    // hook to configure vite dev server
    async configureServer(server) {
      debug('vite plugin - configureServer fn called');

      // this gets re-triggered after .env file updates
      // TODO: be smarter about only reloading if the env files changed?
      if (isFirstLoad) {
        isFirstLoad = false;
      } else if (isDevMode) {
        reloadConfig();
      }

      if (!configIsValid) {
        // triggers the built-in vite error overlay
        server.middlewares.use((req, res, next) => {
          server.hot.send({
            type: 'error',
            err: {
              plugin: 'varlock',
              message: 'Your config is currently invalid - check your terminal for more details',
              stack: '',
            },
          });
          return next();
        });
      }
    },

    transform(code, id, options) {
      // replace build-time ENV.x references
      let magicString = replacerFn(this, code, id);

      // we need to detect if this module is one of our worker entry points
      // when running `vite build`, we could use `this.getModuleInfo(id).isEntry`
      // but that doesnt work in dev, so we try to detect it another way
      let isEntry = false;
      const moduleIds = Array.from(this.getModuleIds());
      if (moduleIds[0] === id) isEntry = true;

      if (isEntry) {
        // using env.command (in config hook) is misleading
        // because some frameworks (react router) boot dev servers during the build process
        // even during the build, there are multiple environments
        // but at least this seems to work for our needs
        const isDevEnv = this.environment.mode === 'dev';

        const injectCode = [
          '// INJECTED BY @varlock/vite-integration ----',
          'globalThis.__varlockThrowOnMissingKeys = true;',
        ];

        // on the code intended for the backend we'll inject init logic
        // and code to load our env, or the already resolved env
        // TODO: keep an eye on environments API, as single ssr flag may be phased out
        if (options?.ssr) {
          let ssrInjectMode = vitePluginOptions?.ssrInjectMode;

          // This will likely end up having more cases to detect
          if (detectedPreset === 'cloudflare-workers') {
            ssrInjectMode ??= 'resolved-env';
          }

          // default to injecting varlock init code only
          ssrInjectMode ??= 'init-only';

          // in dev mode, we only need to inject init code
          // because we'll already have the resolved env available
          // from the vite plugin itself already loading it
          if (isDevEnv) ssrInjectMode = 'init-only';

          if (ssrInjectMode === 'auto-load') {
            injectCode.push(
              "import 'varlock/auto-load';",
            );
          } else {
            if (ssrInjectMode === 'resolved-env') {
              injectCode.push(`globalThis.__varlockLoadedEnv = ${JSON.stringify(varlockLoadedEnv)};`);
            }
            // TODO: we may want to move this to a single module we import
            injectCode.push(
              "import { initVarlockEnv } from 'varlock/env';",
              "import { patchGlobalConsole } from 'varlock/patch-console';",
              "import { patchGlobalServerResponse } from 'varlock/patch-server-response';",
              "import { patchGlobalResponse } from 'varlock/patch-response';",
              'initVarlockEnv();',
              'patchGlobalConsole();',
              'patchGlobalServerResponse();',
              'patchGlobalResponse();',
            );
          }

        // this build is for the client
        } else {
          // in dev mode, on the client we'll inject a list of the existing keys, to provide better error messages
          if (isDevEnv) {
            injectCode.push(
              '// NOTE - __varlockValidKeys is only injected during development',
              `globalThis.__varlockValidKeys = ${JSON.stringify(Object.keys(varlockLoadedEnv?.config || {}))};`,
            );
          }
        }

        injectCode.push('// -------- ');

        magicString ||= new MagicString(code);
        magicString.prepend(`${injectCode.join('\n')}\n`);
      }

      if (!magicString) return null;
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ source: code, includeContent: true, hires: true }),
      };
    },
    renderChunk(code, chunk) {
      // Not 100% positive this is necessary if we've already replaced in transform
      // but the rollup-plugin-define we used as a reference did it, so we'll keep it

      // replace build-time ENV.x references
      const magicString = replacerFn(this, code, chunk.fileName);

      if (!magicString) return null;
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ source: code, includeContent: true, hires: true }),
      };
    },

    // this enables replacing %ENV.xxx% constants in html entry-point files
    // see https://vite.dev/guide/env-and-mode.html#html-constant-replacement
    transformIndexHtml(html) {
      if (!configIsValid) {
        // TODO: build a nice error page somehow and just use it here
        // we should be showing you specific errors and have links to the right files/lines where possible
        return `
<html>
<head>
  <script type="module" src="/@vite/client"></script>
  <title>Invalid config</title>
</head>
<body>
  <h2>Your varlock config is currently invalid!</h2>
  <p>Check your terminal for more details</p>
</body>
</html>
        `;
      }

      //! Note on vite's built-in html constant replacement
      // when using config.define, any import.meta.env.XXX replacements
      // would be automatically added as constant replacements (%XXX%)
      const replacedHtml = html.replace(
        // look for "%ENV.xxx%"
        /%ENV\.([a-zA-Z_][a-zA-Z0-9._]*)%/g,
        (_fullMatch, itemKey) => {
          if (!varlockLoadedEnv.config[itemKey]) {
            throw new Error(`Config item \`${itemKey}\` does not exist`);
          } else if (varlockLoadedEnv.config[itemKey].isSensitive) {
            throw new Error(`Config item \`${itemKey}\` is sensitive and cannot be used in html replacements`);
          } else {
            return varlockLoadedEnv.config[itemKey].value;
          }
        },
      );

      return replacedHtml;
    },
  };
}
