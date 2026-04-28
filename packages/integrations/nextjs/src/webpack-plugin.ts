import fs from 'node:fs';

import {
  redactSensitiveConfig, scanForLeaks, varlockSettings,
} from 'varlock/env';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';

import { type SerializedEnvGraph } from 'varlock';
import { encryptEnvBlobSync } from 'varlock/encrypt-env';
import type { NextConfig } from 'next';

const WEBPACK_PLUGIN_NAME = 'VarlockNextWebpackPlugin';

// We use a proxy object for the static replacements that we pass to webpack.DefinePlugin
// because this plugin/webpack code is not invoked again when env files change
// instead next is direcly messing with the existing plugins for their own changes
// so instead we use a proxy object, and grab the values off of process.env.__VARLOCK_ENV
// which will have been updated by our next-env-compat code
let latestLoadedVarlockEnv: SerializedEnvGraph | undefined;
function createStaticReplacementsProxy(debug: (...args: Array<any>) => void) {
  return new Proxy({} as Record<string, string>, {
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
}

export function createWebpackConfigFn(
  resolvedNextConfig: NextConfig,
  patchGlobalFsMethods: () => void,
  debug: (...args: Array<any>) => void,
  isBuild: boolean,
) {
  const staticReplacementsProxy = createStaticReplacementsProxy(debug);

  return function webpackConfigFn(webpackConfig: any, options: any) {
    debug('varlockNextConfigPlugin webpack config patching');

    const { dev } = options; // also available - isServer, nextRuntime

    // only patch fs methods during builds — they create "hooks" for post-build
    // scanning/scrubbing and are unnecessary during dev
    if (isBuild) patchGlobalFsMethods();

    if (varlockSettings.preventLeaks) {
      // have to wait to run this until here when we know if this is dev mode or not
      patchGlobalServerResponse({
        ignoreUrlPatterns: [
          /^\/__nextjs_source-map\?.*/, // sourcemaps
          /[?&]_rsc=/, // RSC payloads are server-side and expected to contain sensitive data
        ],
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

    // Add per-file init guard for server (non-edge) compilations.
    // Pre-rendering workers may receive compiled code via IPC rather than loading
    // runtime files from disk, so runtime injection alone isn't sufficient.
    // The loader ensures initVarlockEnv() and patchGlobalConsole() run in every worker.
    // alwaysRepatchConsole: in webpack, React wraps console for RSC dev replay AFTER
    // our initial patch in the runtime file, so we re-patch in each file to ensure
    // our redaction wraps React's wrapper. (Turbopack doesn't need this.)
    if (options.isServer && options.nextRuntime !== 'edge') {
      webpackConfig.module.rules.push({
        test: /\.(js|jsx|ts|tsx|mjs|mts)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: require.resolve('./loader'),
            options: { bundler: 'webpack' },
          },
        ],
      });
    }
    // Edge compilation: also re-patch console to wrap React's RSC dev replay wrapper.
    // Edge can't use require(), so we call globalThis.__varlockPatchConsole which the
    // init-edge bundle exposes after running.
    if (options.isServer && options.nextRuntime === 'edge') {
      webpackConfig.module.rules.push({
        test: /\.(js|jsx|ts|tsx|mjs|mts)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: require.resolve('./loader'),
            options: { bundler: 'webpack', isEdge: true },
          },
        ],
      });
    }

    // Set up build-time replacements / rewrites - using webpack.DefinePlugin and a proxy
    // TODO: use shared helpers from core library?
    debug('adding ENV.xxx static replacements proxy object');
    webpackConfig.plugins.push(new webpack.DefinePlugin(staticReplacementsProxy));

    if (varlockSettings.preventLeaks) {
      webpackConfig.plugins.push({
        apply(compiler: any) {
          compiler.hooks.assetEmitted.tap(WEBPACK_PLUGIN_NAME, (_file: any, assetDetails: any) => {
            const { content, targetPath } = assetDetails;

            if (
              targetPath.includes('/.next/static/chunks/')
              || targetPath.endsWith('.html')
              // .rsc and .body are server-side (RSC payloads), not client-facing
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

    // Inject varlock init into webpack runtime files.
    // We prepend the self-contained init bundle as raw JS so it runs before any module code.
    // Server runtimes get the full init (with server-response patching),
    // edge runtimes get the edge-safe init (no node:zlib/node:http).
    function injectVarlockInitIntoWebpackRuntime(edgeRuntime = false) {
      return function assetUpdateFn(origSource: any) {
        const origSourceStr = origSource.source();

        const initBundleName = edgeRuntime ? 'init-edge' : 'init-server';
        const injectorPath = require.resolve(`varlock/${initBundleName}`);
        const injectorSrc = fs.readFileSync(injectorPath, 'utf8');

        // inline the resolved env so it's baked into the build
        // this removes the need for a .env.production.local file on platforms like Vercel
        const rawEnv = process.env.__VARLOCK_ENV;
        let envPayload = rawEnv;
        if (rawEnv && process.env._VARLOCK_ENV_KEY) {
          envPayload = encryptEnvBlobSync(rawEnv, process.env._VARLOCK_ENV_KEY);
        }
        const envInline = envPayload
          ? `process.env.__VARLOCK_ENV = process.env.__VARLOCK_ENV || ${JSON.stringify(envPayload)};`
          : '';

        const updatedSourceStr = [
          envInline,
          // Wrap in IIFE to avoid symbol collisions when bundlers concatenate files.
          // Provide dummy exports/module since the CJS bundle uses `exports.X = ...`
          `(function(exports,module){${injectorSrc}})({},{exports:{}});`,
          origSourceStr,
        ].join('\n');

        return new webpack.sources.RawSource(updatedSourceStr);
      };
    }

    const isEdgeRuntime = options.nextRuntime === 'edge';
    webpackConfig.plugins.push({
      apply(compiler: any) {
        compiler.hooks.thisCompilation.tap(WEBPACK_PLUGIN_NAME, (compilation: any) => {
          compilation.hooks.processAssets.tap(
            {
              name: WEBPACK_PLUGIN_NAME,
              stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
            },
            () => {
              if (isEdgeRuntime) {
                // Edge compilation — only inject the edge-safe init bundle (no node builtins)
                if (compilation.getAsset('edge-runtime-webpack.js')) {
                  compilation.updateAsset('edge-runtime-webpack.js', injectVarlockInitIntoWebpackRuntime(true));
                }
                // Edge compilation also has webpack-runtime.js — inject init-edge there too
                for (const name of ['webpack-runtime.js', '../webpack-runtime.js']) {
                  if (compilation.getAsset(name)) {
                    compilation.updateAsset(name, injectVarlockInitIntoWebpackRuntime(true));
                  }
                }
              } else if (options.isServer) {
                // Server (node.js) compilation — inject full init with server-response patching
                for (const name of ['webpack-runtime.js', '../webpack-runtime.js', 'webpack-api-runtime.js', '../webpack-api-runtime.js']) {
                  if (compilation.getAsset(name)) {
                    compilation.updateAsset(name, injectVarlockInitIntoWebpackRuntime());
                  }
                }
              }
            },
          );
        });
      },
    });

    return webpackConfig; // must return the modified config
  };
}
