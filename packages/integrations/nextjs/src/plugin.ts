/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

import { redactSensitiveConfig, scanForLeaks, varlockSettings } from 'varlock/env';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalConsole } from 'varlock/patch-console';

import { type SerializedEnvGraph } from 'varlock';

// make sure varlock has acutally loaded the env files
// NOTE - we dont need to call `initVarlockEnv` becuase the next-env-compat has already been loaded and called it
if (!process.env.__VARLOCK_ENV) {
  console.error([
    '🚨 process.env.__VARLOCK_ENV is not set 🚨',
    '',
    'To use this plugin, you must override @next/env with @varlock/next-integration',
    'See https://varlock.dev/integrations/nextjs for more information',
    '',
  ].join('\n'));
  throw new Error('VarlockNextWebpackPlugin: __VARLOCK_ENV is not set');
}

patchGlobalConsole();

const IS_WORKER = !!process.env.NEXT_PRIVATE_WORKER;
function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  console.log(
    'plugin',
    IS_WORKER ? '[worker] ' : '[server]',
    '--',
    ...args,
  );
}
debug('✨ LOADED @varlock/next-integration/plugin module!');

const WEBPACK_PLUGIN_NAME = 'VarlockNextWebpackPlugin';

type VarlockPluginOptions = {
  // injectResolvedConfigAtBuildTime: boolean,
};

let scannedStaticFiles = false;
async function scanStaticFiles(nextDirPath: string) {
  scannedStaticFiles = true;
  for await (const file of fs.promises.glob(`${nextDirPath}/**/*.html`)) {
    const fileContents = await fs.promises.readFile(file, 'utf8');
    scanForLeaks(fileContents, { method: 'nextjs scan static html files', file });
  }
}

// not all file writes go through this, at least in Next 15
// (likely because webpack and prerendering are happening in workers)
// but we can use this to monitor writing of certain files and give ourselves a "hook"
// which we can then scan existing files
function patchGlobalFsMethods() {
  // patch fs.promises.writeFile
  const origWriteFileFn = fs.promises.writeFile;
  fs.promises.writeFile = async function dmnoPatchedWriteFile(...args) {
    const filePath = args[0].toString();
    // const fileContents = args[1].toString();
    // console.log('⚡️ patched fs.promises.writeFile', filePath);

    if (filePath.endsWith('/.next/next-server.js.nft.json') && !scannedStaticFiles) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await scanStaticFiles(nextDirPath);
    }

    // // naively enable/disable detection based on file extension... probably not the best logic but it might be enough?
    // if (
    //   filePath.endsWith('.html')
    //   || filePath.endsWith('.rsc')
    //   || filePath.endsWith('.body')
    //   // we also need to scan .js files, but they are already built by webpack so we can't catch it here
    // ) {
    //   // TODO: better error details to help user _find_ the problem
    //   scanForLeaks(fileContents, { method: 'nextjs fs.writeFile', file: filePath });
    // }

    return origWriteFileFn.call(this, ...args);
  };
}



export type NextConfigFunction = (
  phase: string,
  defaults: { defaultConfig: NextConfig },
) => NextConfig | PromiseLike<NextConfig>;


// we make this a plugin a function because we'll likely end up adding some options
export function varlockNextConfigPlugin(pluginOptions?: VarlockPluginOptions) {
  // nextjs doesnt have a proper plugin system :(
  // so we use a function which takes in a config object and returns an augmented one
  return (nextConfig: any | NextConfig | NextConfigFunction): NextConfigFunction => {
    return async (phase: string, defaults: { defaultConfig: NextConfig }) => {
      let resolvedNextConfig: NextConfig;
      if (typeof nextConfig === 'function') {
        const nextConfigFnResult = nextConfig(phase, defaults);
        resolvedNextConfig = await nextConfigFnResult;
      } else {
        resolvedNextConfig = nextConfig;
      }

      if (process.env.TURBOPACK || process.env.npm_config_turbopack) {
        console.error([
          '🚨 @varlock/nextjs-integration: Turbopack is not yet supported for varlockNextConfigPlugin 🚨',
          '',
          'You can either stop using the `--turbopack` flag',
          'or remove this plugin from your config, and only use the @next/env override.',
          "However if you don't use the plugin, you will not get all the benefits of this integration.",
          '',
        ].join('\n'));
        throw new Error('varlockNextConfigPlugin: Turbopack is not yet supported');
      }

      return {
        ...resolvedNextConfig,
        webpack(webpackConfig, options) {
          const { isServer, dev, nextRuntime } = options;

          if (varlockSettings.preventLeaks) {
            // we patch fs methods - ideally we would just path them to scan while files are written
            // but instead we use it to detect what phase the build is in, and then run our own scan on already built files
            patchGlobalFsMethods();

            // have to wait to run this until here when we know if this is dev mode or not
            patchGlobalServerResponse({
              // ignore sourcemaps - although we may in future want to scrub them?
              ignoreUrlPatterns: [/^\/__nextjs_source-map\?.*/],
              // in dev mode, we redact the secrets rather than throwing, because otherwise the dev server crashes
              redactInsteadOfThrow: dev,
            });
          }

          // webpack itself is passed in so we dont have to import it (or make it a dependency)
          const webpack = options.webpack;

          // apply existing user customizations if there are any
          if (resolvedNextConfig.webpack) {
            webpackConfig = resolvedNextConfig.webpack(webpackConfig, options);
          }


          // Set up build-time replacements / rewrites (using webpack.DefinePlugin)
          const staticReplacements = {} as Record<string, string>;
          // TODO: use shared helper function?
          if (!process.env.__VARLOCK_ENV) throw new Error('VarlockNextWebpackPlugin: __VARLOCK_ENV is not set');
          const varlockEnv = JSON.parse(process.env.__VARLOCK_ENV) as SerializedEnvGraph;
          for (const itemKey in varlockEnv.config) {
            const item = varlockEnv.config[itemKey];
            // TODO: probably want to reimplement static/dynamic logic, and allow sensitive+static / public+dynamic
            if (!item.isSensitive) {
              staticReplacements[`ENV.${itemKey}`] = JSON.stringify(item.value);
            }
          }

          debug('adding static replacements!', staticReplacements);
          webpackConfig.plugins.push(new webpack.DefinePlugin(staticReplacements));

          if (varlockSettings.preventLeaks) {
            webpackConfig.plugins.push({
              apply(compiler: any) {
                compiler.hooks.assetEmitted.tap(WEBPACK_PLUGIN_NAME, (file: any, assetDetails: any) => {
                  const { content, targetPath } = assetDetails;
                  debug('emit file: ', targetPath);

                  if (
                    targetPath.includes('/.next/static/chunks/')
                    // Dont think these actually ever happen?
                    || targetPath.endsWith('.html')
                    || targetPath.endsWith('.body')
                    || targetPath.endsWith('.rsc')
                  ) {
                    // NOTE - in dev mode the request hangs on the error, but the console error should help
                    // and during a build, it will actually fail the build
                    try {
                      scanForLeaks(content, {
                        method: '@varlock/nextjs-integration/plugin - assetEmitted hook',
                        file: targetPath,
                      });
                    } catch (err) {
                      if (dev) {
                        // overwrite file with redacted version
                        fs.writeFileSync(targetPath, redactSensitiveConfig(content.toString()));
                      } else {
                        throw err;
                      }
                    }
                  }
                });
              },
            });
          }




          // we need to inject the dmno globals injector and call it
          // and in vercel/netlify etc where we can't run via `dmno run` we need to inject the resolved config into the build
          // not sure if this is the best way, but injecting into the `webpack-runtime.js` file seems to run everywhere

          // updates the webpack source to inject dmno global logic and call it
          // we run this on the runtimes for serverless and edge
          function injectVarlockInitIntoWebpackRuntime(edgeRuntime = false) {
            return function (origSource: any) {
              const origSourceStr = origSource.source();

              // we will inline the injector code, but need a different version if we are running in the edge runtime
              // const injectorSrc = getCjsModuleSource(`dmno/injector-standalone${edgeRuntime ? '/edge' : ''}`);
              const injectorPath = path.resolve(__dirname, './patch-next-runtime.js');
              const injectorSrc = fs.readFileSync(injectorPath, 'utf8');


              const updatedSourceStr = [
                // we use `headers()` to force next into dynamic rendering mode, but on the edge runtime it's always dynamic
                // (see below for where headers is used)
                // !edgeRuntime ? 'const { headers } = require("next/headers");' : '',

                // // code built for edge runtime does not have `module.exports` or `exports` but we are inlining some already built common-js code
                // // so we just create them. It's not needed since it is inlined and we call the function right away
                // edgeRuntime ? 'const module = { exports: {} }; const exports = {}' : '',

                // inline the dmno injector code and then call it
                injectorSrc,

                // 'injectDmnoGlobals({',
                // injectResolvedConfigAtBuildTime ? `injectedConfig: ${JSON.stringify(injectedDmnoEnv)},` : '',

                // // attempts to force the route into dynamic rendering mode so it wont put our our dynamic value into a pre-rendered page
                // // however we have to wrap in try/catch because you can only call headers() within certain parts of the page... so it's not 100% foolproof
                // !edgeRuntime ? `
                //   onItemAccess: async (item) => {
                //     if (item.dynamic) {
                //       try { headers(); }
                //       catch (err) {}
                //     }
                //   },` : '',
                // '});',

                origSourceStr,
              ].join('\n');

              return new webpack.sources.RawSource(updatedSourceStr);
            };
          }

          webpackConfig.plugins.push({
            apply(compiler: any) {
              compiler.hooks.thisCompilation.tap(WEBPACK_PLUGIN_NAME, (compilation: any) => {
                compilation.hooks.processAssets.tap(
                  {
                    name: WEBPACK_PLUGIN_NAME,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
                  },
                  () => {
                    // not sure why, but these paths are different in build vs dev
                    if (compilation.getAsset('webpack-runtime.js')) {
                      compilation.updateAsset('webpack-runtime.js', injectVarlockInitIntoWebpackRuntime());
                    }
                    if (compilation.getAsset('../webpack-runtime.js')) {
                      compilation.updateAsset('../webpack-runtime.js', injectVarlockInitIntoWebpackRuntime());
                    }
                    if (compilation.getAsset('webpack-api-runtime.js')) {
                      compilation.updateAsset('webpack-api-runtime.js', injectVarlockInitIntoWebpackRuntime());
                    }
                    if (compilation.getAsset('../webpack-api-runtime.js')) {
                      compilation.updateAsset('../webpack-api-runtime.js', injectVarlockInitIntoWebpackRuntime());
                    }

                    if (compilation.getAsset('edge-runtime-webpack.js')) {
                      compilation.updateAsset('edge-runtime-webpack.js', injectVarlockInitIntoWebpackRuntime(true));
                    }
                  },
                );
              });
            },

          });

          return webpackConfig; // must return the modified config
        },
      };
    };
  };
}
