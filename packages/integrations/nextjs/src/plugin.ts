/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

import {
  getRedactionMapInfo, initVarlockEnv, redactSensitiveConfig, scanForLeaks, varlockSettings,
} from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';

import { type SerializedEnvGraph } from 'varlock';
import { createWebpackConfigFn } from './webpack-plugin';
import { injectVarlockInitIntoTurbopackRuntime, isInjectedTurbopackRuntime } from './turbopack-runtime-inject';

// make sure varlock has actually loaded the env files
// NOTE - we don't need to call `initVarlockEnv` because the next-env-compat has already been loaded and called it
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

// Turbopack detection at module level — needed to apply patches in worker processes
// (the config function only runs in the main process, but workers also load this module)
const IS_TURBOPACK = !!(
  process.env.TURBOPACK
  || process.env.TURBOPACK_DEV
  || process.env.TURBOPACK_BUILD
  || process.env.npm_config_turbopack
);

// For turbopack, apply server response patching at module level so it takes effect
// in worker processes (which serve actual responses). The config function's turbopack
// branch only runs in the main process, which doesn't handle HTTP responses.
if (IS_TURBOPACK && varlockSettings.preventLeaks) {
  patchGlobalServerResponse({
    ignoreUrlPatterns: [
      /^\/__nextjs_source-map\?.*/, // sourcemaps
      /[?&]_rsc=/, // RSC payloads are server-side and expected to contain sensitive data
    ],
    // always redact in dev to avoid crashing the dev server; prod builds override via init bundles
    redactInsteadOfThrow: true,
  });
}

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

let scannedBuildOutput = false;
async function scanBuildOutputForLeaks(nextDirPath: string, opts?: { failBuild?: boolean }) {
  if (scannedBuildOutput) return;
  scannedBuildOutput = true;

  // varlockSettings may not be populated if initVarlockEnv hasn't run in this process,
  // so fall back to reading the setting directly from the env data
  let preventLeaks = varlockSettings.preventLeaks;
  if (preventLeaks === undefined && process.env.__VARLOCK_ENV) {
    try {
      const envGraph: SerializedEnvGraph = JSON.parse(process.env.__VARLOCK_ENV);
      preventLeaks = envGraph.settings?.preventLeaks;
    } catch { /* ignore */ }
  }
  // Ensure the redaction map is populated so scanForLeaks knows what to look for.
  // initVarlockEnv may not have run in this process (the plugin's main process).
  if (process.env.__VARLOCK_ENV) {
    // eslint-disable-next-line @stylistic/max-statements-per-line
    try { initVarlockEnv(); } catch { /* ignore if already initialized or fails */ }
  }
  const redactionInfo = getRedactionMapInfo();
  debug(`scanBuildOutputForLeaks: preventLeaks=${preventLeaks}, redactionInfo=${JSON.stringify(redactionInfo)}`);
  if (!preventLeaks) return;

  const leakedFiles: Array<string> = [];
  let scannedCount = 0;

  // scan JS chunks in .next/static/chunks/ — these are client-facing bundles
  // that should never contain sensitive values
  for await (const file of fs.promises.glob(`${nextDirPath}/static/chunks/**/*.js`)) {
    scannedCount++;
    const fileContents = await fs.promises.readFile(file, 'utf8');
    try {
      scanForLeaks(fileContents, {
        method: 'nextjs post-build scan (static chunks)',
        file,
      });
    } catch (err) {
      leakedFiles.push(file);
      // redact the file so the leak doesn't ship
      await fs.promises.writeFile(file, redactSensitiveConfig(fileContents));
    }
  }

  debug(`scanned ${scannedCount} static chunk files in ${nextDirPath}/static/chunks/`);

  // scan prerendered HTML files (client-facing static output)
  // NOTE: .rsc and .body files are server-side (RSC payloads) and are expected
  // to access sensitive data, so we don't scan those
  for (const ext of ['html']) {
    for await (const file of fs.promises.glob(`${nextDirPath}/**/*.${ext}`)) {
      scannedCount++;
      const fileContents = await fs.promises.readFile(file, 'utf8');
      try {
        scanForLeaks(fileContents, {
          method: `nextjs post-build scan (.${ext})`,
          file,
        });
      } catch (err) {
        leakedFiles.push(file);
        await fs.promises.writeFile(file, redactSensitiveConfig(fileContents));
      }
    }
  }

  debug(`scanned ${scannedCount} total build output files`);

  if (leakedFiles.length > 0) {
    const msg = `[varlock] ⚠️ found and redacted leaked secrets in ${leakedFiles.length} build output file(s):\n${leakedFiles.map((f) => `  - ${f}`).join('\n')}`;
    if (opts?.failBuild) {
      throw new Error(msg);
    }
    console.error(msg);
  } else {
    debug('✅ no leaks found in build output');
  }
}

// not all file writes go through this, at least in Next 15
// (likely because webpack and prerendering are happening in workers)
// but we can use this to monitor writing of certain files and give ourselves a "hook"
// which we can then scan existing files
function patchGlobalFsMethods() {
  debug('patching global fs methods');
  // patch fs.promises.writeFile
  const origWriteFileFn = fs.promises.writeFile;
  fs.promises.writeFile = async function dmnoPatchedWriteFile(...args) {
    const filePath = args[0].toString();
    debug('fs.promises.writeFile:', filePath);

    // BUILD_ID is written after turbopack compilation completes but before pre-rendering.
    // This is our hook to inject the init bundle into turbopack runtime files.
    if (!isInjectedTurbopackRuntime() && filePath.endsWith('/.next/export-detail.json')) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      injectVarlockInitIntoTurbopackRuntime(nextDirPath);
    }

    if (filePath.endsWith('/.next/next-server.js.nft.json') && !scannedStaticFiles) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await scanStaticFiles(nextDirPath);
    }
    // next-server.js.nft.json is written near the end of the build, after prerendering (webpack)
    // prerender-manifest.json is written after "Generating static pages" completes (turbopack + webpack)
    if (
      filePath.endsWith('/.next/next-server.js.nft.json')
      || filePath.endsWith('/.next/prerender-manifest.json')
    ) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      if (!scrubbedSourcemaps) await scrubSourcemaps(nextDirPath);
      if (!scannedBuildOutput) await scanBuildOutputForLeaks(nextDirPath, { failBuild: true });
    }

    return origWriteFileFn.call(this, ...args);
  };

  // also patch sync version in case turbopack uses it
  const origWriteFileSyncFn = fs.writeFileSync;
  fs.writeFileSync = function dmnoPatchedWriteFileSync(...args: Parameters<typeof fs.writeFileSync>) {
    const filePath = args[0].toString();
    debug('fs.writeFileSync:', filePath);

    if (!isInjectedTurbopackRuntime() && filePath.endsWith('/.next/diagnostics/build-diagnostics.json')) {
      const nextDirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      injectVarlockInitIntoTurbopackRuntime(nextDirPath);
    }

    return origWriteFileSyncFn.call(this, ...args);
  };
}


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
      const isBuild = phase === 'phase-production-build';
      debug(`turbopack detection: TURBOPACK=${process.env.TURBOPACK}, TURBOPACK_DEV=${process.env.TURBOPACK_DEV}, TURBOPACK_BUILD=${process.env.TURBOPACK_BUILD}, phase=${phase}, isTurbopack=${isTurbopack}, isBuild=${isBuild}`);

      // For production builds, schedule a post-build scan as a safety net.
      // The fs.writeFile patches may not intercept all writes (workers), and
      // BUILD_ID is written before prerendering completes. beforeExit fires
      // after the build finishes, ensuring all output files exist.
      if (isBuild) {
        process.once('beforeExit', () => {
          const nextDirPath = path.resolve(process.cwd(), '.next');
          const scanPromises: Array<Promise<void>> = [];
          if (!scrubbedSourcemaps) scanPromises.push(scrubSourcemaps(nextDirPath));
          if (!scannedBuildOutput) scanPromises.push(scanBuildOutputForLeaks(nextDirPath, { failBuild: true }));
          if (scanPromises.length > 0) {
            // The async work keeps the event loop alive, and beforeExit
            // will fire again once it completes (but the guards prevent re-runs)
            Promise.all(scanPromises).catch((err) => {
              console.error('[varlock] post-build scan failed:', err);
              process.exitCode = 1;
            });
          }
        });
      }

      if (isTurbopack) {
        debug('turbopack detected, injecting loader rules');
        // only patch fs methods during builds — they create "hooks" for post-build
        // scanning/scrubbing and are unnecessary (and noisy) during dev
        if (isBuild) patchGlobalFsMethods();

        // turbopack config can be under `turbopack` (Next 15+) or `experimental.turbo` (older)
        let turbopackConfig = (resolvedNextConfig as any).turbopack
          ?? (resolvedNextConfig as any).experimental?.turbo;

        if (!turbopackConfig) {
          turbopackConfig = {};
          (resolvedNextConfig as any).turbopack = turbopackConfig;
        }

        // inject loader rules
        const loaderRule = {
          loaders: [require.resolve('./loader')],
        };
        turbopackConfig.rules ||= {};
        turbopackConfig.rules['*.{js,jsx,ts,tsx,mjs,mts}'] = loaderRule;

        // Turbopack can't resolve symlinked packages (e.g. link: or workspace: installs).
        // If varlock is symlinked, we copy dist files into node_modules/.varlock/ as real
        // files and set up resolve aliases so turbopack can find them.
        const varlockNodeModulesPath = path.resolve(process.cwd(), 'node_modules/varlock');
        let isSymlinked = false;
        try {
          isSymlinked = fs.lstatSync(varlockNodeModulesPath).isSymbolicLink();
        } catch { /* not found — might be hoisted or nested, skip */ }

        if (isSymlinked) {
          debug('varlock is symlinked, copying dist files for turbopack');
          const varlockDistDir = path.resolve(path.dirname(require.resolve('varlock/env')), '..');
          const varlockRoot = path.resolve(varlockDistDir, '..');
          const cacheDir = path.resolve(process.cwd(), 'node_modules/.varlock');
          const cacheDistDir = path.join(cacheDir, 'dist');
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            // copy dist/ and package.json so turbopack can resolve subpath exports
            fs.cpSync(varlockDistDir, cacheDistDir, { recursive: true });
            fs.copyFileSync(path.join(varlockRoot, 'package.json'), path.join(cacheDir, 'package.json'));
            debug('copied varlock package files to', cacheDir);
          } catch (err) {
            console.warn('[varlock] failed to copy varlock package files:', err);
          }

          turbopackConfig.resolveAlias ||= {};
          turbopackConfig.resolveAlias['varlock/env'] = './node_modules/.varlock/dist/runtime/env.js';
          turbopackConfig.resolveAlias['varlock/patch-console'] = './node_modules/.varlock/dist/runtime/patch-console.js';
          turbopackConfig.resolveAlias['varlock/patch-server-response'] = './node_modules/.varlock/dist/runtime/patch-server-response.js';
          turbopackConfig.resolveAlias['varlock/patch-response'] = './node_modules/.varlock/dist/runtime/patch-response.js';
          turbopackConfig.resolveAlias['varlock/init-server'] = './node_modules/.varlock/dist/runtime/init-server.cjs';
          turbopackConfig.resolveAlias['varlock/init-edge'] = './node_modules/.varlock/dist/runtime/init-edge.cjs';
          debug('set resolveAlias for varlock subpaths -> ./node_modules/.varlock/dist/...');
        } else {
          debug('varlock is not symlinked, turbopack can resolve it natively');
        }
      }

      return {
        ...resolvedNextConfig,
        ...isTurbopack && {
          turbopack: (resolvedNextConfig as any).turbopack,
        },
        ...!IS_TURBOPACK && {
          webpack: createWebpackConfigFn(resolvedNextConfig, patchGlobalFsMethods, debug, isBuild),
        },
      };
    };
  };
}
