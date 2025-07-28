import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Plugin } from 'vite';
import Debug from 'debug';

import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';
import { SerializedEnvGraph } from 'varlock';

import { definePlugin } from './define-plugin';

// need to track original process.env, since we will be modifying it
const originalProcessEnv = { ...process.env };

const debug = Debug('varlock:vite-integration');

let isFirstLoad = !(process as any).__VARLOCK_ENV;

debug('varlock vite plugin loaded. first load = ', isFirstLoad);

let isDevMode: boolean;
let configIsValid = true;
let varlockLoadedEnv: SerializedEnvGraph;
let staticReplacements: Record<string, any> = {};
let rollupDefinePlugin: ReturnType<typeof definePlugin>;

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


  staticReplacements = {};
  for (const itemKey in varlockLoadedEnv?.config) {
    const itemInfo = varlockLoadedEnv.config[itemKey];
    // TODO: probably reimplement static/dynamic controls here too
    if (!itemInfo.isSensitive) {
      const val = JSON.stringify(itemInfo.value);
      staticReplacements[`ENV.${itemKey}`] = val;
    }
  }

  rollupDefinePlugin = definePlugin({
    replacements: staticReplacements,
  });
}

// we run this right away so the globals get injected into the vite.config file
reloadConfig();

export function varlockVitePlugin(
  options?: {}, // TODO: add options? like allow injecting sensitive config?
): Plugin {
  return {
    name: 'inject-varlock-config',

    // hook to modify config before it is resolved
    async config(config, env) {
      debug('vite plugin - config fn called');
      isDevMode = env.command === 'serve';

      if (isFirstLoad) {
        isFirstLoad = false;
      } else if (isDevMode) {
        reloadConfig();
      }

      // console.log('adding static replacements', staticReplacements);
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
    // hook tp configure vite dev server
    async configureServer(server) {
      debug('vite plugin - configureServer fn called');
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

    // Delegate replacement to our slightly modified rollup define plugin
    transform(...args) {
      // @ts-ignore
      return rollupDefinePlugin.transform.call(this, ...args);
    },
    renderChunk(code, chunk) {
      // @ts-ignore
      return rollupDefinePlugin.transform.call(this, code, chunk.fileName);
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

      const injectGlobalCode = [] as Array<string>;
      injectGlobalCode.push('globalThis.__varlockThrowOnMissingKeys = true;');
      if (isDevMode) {
        injectGlobalCode.push(...[
          '// NOTE - this is only injected during development',
          `globalThis.__varlockValidKeys = ${JSON.stringify(Object.keys(varlockLoadedEnv?.config || {}))};`,
        ]);
      }

      return {
        html: replacedHtml,
        tags: [{ tag: 'script', attrs: { type: 'module' }, children: injectGlobalCode.join('\n') }],
      };
    },
  };
}
