/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

import {
  redactSensitiveConfig, scanForLeaks, varlockSettings,
} from 'varlock/env';
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

let scrubbedSourcemaps = false;
async function scrubSourcemaps(nextDirPath: string) {
  if (scrubbedSourcemaps) return;
  scrubbedSourcemaps = true;

  // build a list of sensitive values and their same-length replacements
  const envGraph: SerializedEnvGraph = JSON.parse(process.env.__VARLOCK_ENV || '{}');
  const sensitiveValues: Array<{ value: string, replacement: string }> = [];
  for (const itemKey in envGraph.config) {
    const item = envGraph.config[itemKey];
    if (item.isSensitive && item.value && typeof item.value === 'string' && item.value.length > 0) {
      // same-length replacement to preserve sourcemap column offsets
      sensitiveValues.push({
        value: item.value,
        replacement: '*'.repeat(item.value.length),
      });
    }
  }
  if (!sensitiveValues.length) {
    debug('no sensitive values to scrub from sourcemaps');
    return;
  }
  // sort longest first for maximal munch
  sensitiveValues.sort((a, b) => b.value.length - a.value.length);

  let scrubCount = 0;
  for await (const mapFile of fs.promises.glob(`${nextDirPath}/**/*.map`)) {
    const contents = await fs.promises.readFile(mapFile, 'utf8');
    let scrubbed = contents;
    for (const { value, replacement } of sensitiveValues) {
      scrubbed = scrubbed.replaceAll(value, replacement);
    }
    if (scrubbed !== contents) {
      await fs.promises.writeFile(mapFile, scrubbed);
      scrubCount++;
    }
  }
  debug(`scrubbed sensitive values from ${scrubCount} sourcemap files`);
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
    debug('⚡️ fs.promises.writeFile:', filePath);

    if (filePath.endsWith('/.next/next-server.js.nft.json') && !scannedStaticFiles) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await scanStaticFiles(nextDirPath);
    }
    if (filePath.endsWith('/.next/BUILD_ID') && !scrubbedSourcemaps) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await scrubSourcemaps(nextDirPath);
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

  // also patch sync version in case turbopack uses it
  const origWriteFileSyncFn = fs.writeFileSync;
  fs.writeFileSync = function dmnoPatchedWriteFileSync(...args: Parameters<typeof fs.writeFileSync>) {
    const filePath = args[0].toString();
    debug('⚡️ fs.writeFileSync:', filePath);
    return origWriteFileSyncFn.call(this, ...args);
  };
}


// We use a proxy object for the static replacements that we pass to webpack.DefinePlugin
// because this plugin/webpack code is not invoked again when env files change
// instead next is direcly messing with the existing plugins for their own changes
// so instead we use a proxy object, and grab the values off of process.env.__VARLOCK_ENV
// which will have been updated by our next-env-compat code
let latestLoadedVarlockEnv: SerializedEnvGraph | undefined;
const StaticReplacementsProxy = new Proxy({} as Record<string, string>, {
  ownKeys(_target) {
    latestLoadedVarlockEnv = JSON.parse(process.env.__VARLOCK_ENV || '{}') as SerializedEnvGraph;
    const replaceKeys = [] as Array<string>;
    for (const itemKey in latestLoadedVarlockEnv.config) {
      const item = latestLoadedVarlockEnv.config[itemKey];
      if (!item.isSensitive) replaceKeys.push(`ENV.${itemKey}`);
    }
    debug('reloaded static replacements keys', replaceKeys);
    return replaceKeys;
  },
  getOwnPropertyDescriptor(_target, prop) {
    const itemKey = prop.toString().split('.')[1];
    const item = latestLoadedVarlockEnv?.config[itemKey];
    if (!item || item.isSensitive) return;
    return {
      value: '', // this value is not used, the get handler will return the value
      writable: false,
      enumerable: true,
      configurable: true,
    };
  },
  get(_target, prop) {
    const itemKey = prop.toString().split('.')[1];
    const item = latestLoadedVarlockEnv?.config[itemKey];
    if (item && !item.isSensitive) return JSON.stringify(item.value);
  },
});




export type NextConfigFunction = (
  phase: string,
  defaults: { defaultConfig: NextConfig },
) => NextConfig | PromiseLike<NextConfig>;


// we make this a plugin a function because we'll likely end up adding some options
export function varlockNextConfigPlugin(_pluginOptions?: VarlockPluginOptions) {
  // nextjs doesnt have a proper plugin system :(
  // so we use a function which takes in a config object and returns an augmented one
  return (nextConfig: any | NextConfig | NextConfigFunction): NextConfigFunction => {
    debug('varlockNextConfigPlugin init fn');

    return async (phase: string, defaults: { defaultConfig: NextConfig }) => {
      let resolvedNextConfig: NextConfig;
      if (typeof nextConfig === 'function') {
        const nextConfigFnResult = nextConfig(phase, defaults);
        resolvedNextConfig = await nextConfigFnResult;
      } else {
        resolvedNextConfig = nextConfig;
      }

      // Next 16+ uses Turbopack by default for dev, but may not set TURBOPACK env var
      const isTurbopack = !!(
        process.env.TURBOPACK
        || process.env.TURBOPACK_DEV
        || process.env.TURBOPACK_BUILD
        || process.env.npm_config_turbopack
      );
      debug(`turbopack detection: TURBOPACK=${process.env.TURBOPACK}, TURBOPACK_DEV=${process.env.TURBOPACK_DEV}, TURBOPACK_BUILD=${process.env.TURBOPACK_BUILD}, phase=${phase}, isTurbopack=${isTurbopack}`);

      if (isTurbopack) {
        debug('turbopack detected, injecting turbopack loader rules');
        patchGlobalFsMethods();

        // turbopack config can be under `turbopack` (Next 15+) or `experimental.turbo` (older)
        let turbopackConfig = (resolvedNextConfig as any).turbopack
          ?? (resolvedNextConfig as any).experimental?.turbo;

        if (!turbopackConfig) {
          turbopackConfig = {};
          (resolvedNextConfig as any).turbopack = turbopackConfig;
        }

        // inject loader rules
        const loaderRule = {
          loaders: [require.resolve('./turbopack-loader')],
        };
        turbopackConfig.rules ||= {};
        turbopackConfig.rules['*.{js,jsx,ts,tsx,mjs,mts}'] = loaderRule;

        // alias varlock/env to our self-contained bundle so Turbopack can resolve it
        // (Turbopack resolves imports before running loaders, so without this alias
        // the import fails before our loader gets a chance to transform it)
        // We copy the bundle into node_modules/.varlock/ because Turbopack can't
        // resolve symlinked workspace packages, and doesn't support absolute paths
        const inlineSrc = path.resolve(__dirname, './varlock-env-inline.js');
        const cacheDir = path.resolve(process.cwd(), 'node_modules/.varlock');
        const inlineDest = path.join(cacheDir, 'env-inline.js');
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.copyFileSync(inlineSrc, inlineDest);
          debug('copied varlock-env-inline.js to', inlineDest);
        } catch (err) {
          console.warn('[varlock] failed to copy env-inline bundle:', err);
        }
        turbopackConfig.resolveAlias ||= {};
        // The inline bundle is self-contained (includes env runtime + all patches).
        // Alias varlock/env and all patch subpaths to it so Turbopack can resolve them.
        // The patches are idempotent so it's safe if the module is imported multiple times.
        turbopackConfig.resolveAlias['varlock/env'] = './node_modules/.varlock/env-inline.js';
        turbopackConfig.resolveAlias['varlock/patch-console'] = './node_modules/.varlock/env-inline.js';
        turbopackConfig.resolveAlias['varlock/patch-server-response'] = './node_modules/.varlock/env-inline.js';
        turbopackConfig.resolveAlias['varlock/patch-response'] = './node_modules/.varlock/env-inline.js';
        debug('set resolveAlias for varlock/env + patches -> ./node_modules/.varlock/env-inline.js');
      }

      return {
        ...resolvedNextConfig,
        // turbopack config needs to be spread through
        ...(isTurbopack ? { turbopack: (resolvedNextConfig as any).turbopack } : {}),
        webpack(webpackConfig, options) {
          debug('varlockNextConfigPlugin webpack config patching');

          const { dev } = options; // also available - isServer, nextRuntime

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

          if (!process.env.__VARLOCK_ENV) throw new Error('VarlockNextWebpackPlugin: __VARLOCK_ENV is not set');

          // Set up build-time replacements / rewrites - using webpack.DefinePlugin and a proxy
          // TODO: use shared helpers from core library?
          debug('adding ENV.xxx static replacements proxy object');
          webpackConfig.plugins.push(new webpack.DefinePlugin(StaticReplacementsProxy));

          if (varlockSettings.preventLeaks) {
            webpackConfig.plugins.push({
              apply(compiler: any) {
                compiler.hooks.assetEmitted.tap(WEBPACK_PLUGIN_NAME, (file: any, assetDetails: any) => {
                  const { content, targetPath } = assetDetails;
                  // debug('emit file: ', targetPath);

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
          function injectVarlockInitIntoWebpackRuntime(_edgeRuntime = false) {
            return function assetUpdateFn(origSource: any) {
              const origSourceStr = origSource.source();

              const injectorPath = path.resolve(__dirname, './patch-next-runtime.js');
              const injectorSrc = fs.readFileSync(injectorPath, 'utf8');

              // inline the resolved env so it's baked into the build
              // this removes the need for a .env.production.local file on platforms like Vercel
              const rawEnv = process.env.__VARLOCK_ENV;
              const envInline = rawEnv
                ? `process.env.__VARLOCK_ENV = process.env.__VARLOCK_ENV || ${JSON.stringify(rawEnv)};`
                : '';

              const updatedSourceStr = [
                envInline,
                injectorSrc,
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
