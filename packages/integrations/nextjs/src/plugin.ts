/* eslint-disable prefer-rest-params */

import fs from 'node:fs';
// import { fileURLToPath } from 'node:url';
// import { injectDmnoGlobals } from 'dmno/injector-standalone';
// import { resolve } from 'import-meta-resolve';
import type { NextConfig } from 'next';
import { getBuildTimeReplacements, patchServerResponseToPreventClientLeaks, scanForLeaks } from 'varlock';

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

const ENABLE_LEAK_DETECTION = true;

// const {
//   staticReplacements, dynamicKeys, injectedDmnoEnv, serviceSettings,
// } = injectDmnoGlobals();

type VarlockPluginOptions = {
  // injectResolvedConfigAtBuildTime: boolean,
};



// this seems to not catch anything in next 15 - as it only covers manifest files
// but it can't hurt to add it
function patchFsWriteFileToScanForLeaks() {
  const origPromisesWriteFileFn = fs.promises.writeFile;
  fs.promises.writeFile = function dmnoPatchedWriteFile(...args) {
    const [filePath, fileContents] = arguments;

    // naively enable/disable detection based on file extension... probably not the best logic but it might be enough?
    if (
      filePath.endsWith('.html')
      || filePath.endsWith('.rsc')
      || filePath.endsWith('.body')
      // we also need to scan .js files, but they are already built by webpack so we can't catch it here
    ) {
      // TODO: better error details to help user _find_ the problem
      scanForLeaks(fileContents, { method: 'nextjs fs.writeFile', file: filePath });
    }

    // @ts-ignore
    return origPromisesWriteFileFn.call(this, ...Array.from(arguments));
  };
}



export type NextConfigFunction = (
  phase: string,
  defaults: { defaultConfig: NextConfig },
) => NextConfig | PromiseLike<NextConfig>;



const WEBPACK_PLUGIN_NAME = 'VarlockNextWebpackPlugin';

// function getCjsModuleSource(moduleName: string) {
//   const modulePath = fileURLToPath(resolve(moduleName, import.meta.url)).replace('.js', '.cjs');
//   const moduleSrc = fs.readFileSync(modulePath, 'utf8');
//   return moduleSrc;
// }

// we make this a function because we'll likely end up adding some options
export function varlockNextConfigPlugin(pluginOptions?: VarlockPluginOptions) {
  if (ENABLE_LEAK_DETECTION) {
    // patches fs.writeFile to scan files output by next itself for leaks
    // (does not include files output during webpack build)
    patchFsWriteFileToScanForLeaks();
    patchServerResponseToPreventClientLeaks({
      ignoreUrlPatterns: [/^\/__nextjs_source-map\?.*/],
    });
  }

  // // detect if we need to build the resolved config into the output
  // // which is needed when running on external platforms where we dont have ability to use `dmno run`
  // const injectResolvedConfigAtBuildTime = (
  //   (process.env.__VERCEL_BUILD_RUNNING || process.env.VERCEL) // build running via `vercel` cli or on vercel
  //   || process.env.NETLIFY // build running remotely on netlify
  //   || (process.env.NETLIFY_LOCAL && !process.env.NETLIFY_DEV) // build running locally via `netlify` cli
  //   || process.env.CF_PAGES // maybe add additional check for /functions folder?
  //   || dmnoOptions?.injectResolvedConfigAtBuildTime // explicit opt-in

  // );

  // nextjs doesnt have a proper plugin system, so we write a function which takes in a config object and returns an augmented one
  return (nextConfig: any | NextConfig | NextConfigFunction): NextConfigFunction => {
    return async (phase: string, defaults: { defaultConfig: NextConfig }) => {
      let resolvedNextConfig: NextConfig;
      if (typeof nextConfig === 'function') {
        const nextConfigFnResult = nextConfig(phase, defaults);
        resolvedNextConfig = await nextConfigFnResult;
      } else {
        resolvedNextConfig = nextConfig;
      }

      // if (resolvedNextConfig.output === 'export' && dynamicKeys.length) {
      //   console.error([
      //     'Dynamic config is not supported in static builds (next.config output="export")',
      //     'Set `settings.dynamicConfig` to "only_static" in your .dmno/config.mts file',
      //     `Dynamic config items: ${dynamicKeys.join(', ')}`,
      //   ].join('\n'));

      //   throw new Error('Dynamic config not compatible with static builds');
      // }

      return {
        ...resolvedNextConfig,
        webpack(webpackConfig, options) {
          const { isServer, dev, nextRuntime } = options;

          // webpack itself  is passed in so we dont have to import it...
          const webpack = options.webpack;

          // apply existing user customizations if there are any
          if (resolvedNextConfig.webpack) {
            webpackConfig = resolvedNextConfig.webpack(webpackConfig, options);
          }


          // Set up build-time replacements / rewrites (using webpack.DefinePlugin)
          const staticReplacements = getBuildTimeReplacements({
            // includeSensitive: isServer,
          });
          debug('adding static replacements!', staticReplacements);
          webpackConfig.plugins.push(new webpack.DefinePlugin(staticReplacements));


          webpackConfig.plugins.push({
            apply(compiler: any) {
              compiler.hooks.assetEmitted.tap(WEBPACK_PLUGIN_NAME, (file: any, assetDetails: any) => {
                const { content, targetPath } = assetDetails;
                debug('emit file: ', targetPath);

                if (
                  targetPath.includes('/.next/static/chunks/')
                  || targetPath.endsWith('.html')
                  || targetPath.endsWith('.body')
                  || targetPath.endsWith('.rsc')
                ) {
                  // NOTE - in dev mode the request hangs on the error, but the console error should help
                  // and during a build, it will actually fail the build

                  scanForLeaks(content, {
                    method: '@varlock/nextjs-integration/plugin - assetEmitted hook',
                    file: targetPath,
                  });
                }
              });


              // compiler.hooks.thisCompilation.tap(WEBPACK_PLUGIN_NAME, (compilation: any) => {
              //   // add webpack hook to handle leaks in 'use client' pages
              //   // since this ends up in a built js file instead of a server response
              //   if (ENABLE_LEAK_DETECTION) {
              //     // scan built js files
              //     compiler.hooks.assetEmitted.tap(
              //       WEBPACK_PLUGIN_NAME,
              //       (file: any, assetDetails: any) => {
              //         const { content, targetPath } = assetDetails;

              //         debug('scanning file: ', targetPath);

              //         // if (targetPath.includes('/.next/static/chunks/')) {
              //         //   // NOTE - in dev mode the request hangs on the error, but the console error should help
              //         //   // and during a build, it will actually fail the build
              //         //   (globalThis as any)._dmnoLeakScan(content, {
              //         //     method: 'nextjs webpack plugin - static chunks',
              //         //     file: targetPath,
              //         //   });
              //         // }
              //       },
              //     );
              //   }
              // });
            },
          });


          return webpackConfig; // must return the modified config
        },
      };
    };
  };
}
