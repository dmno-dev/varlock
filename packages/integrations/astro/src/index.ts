import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDebug, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { scanForLeaks, varlockSettings } from 'varlock/env';
import { varlockVitePlugin, type VarlockVitePluginOptions } from '@varlock/vite-integration';
import type { AstroIntegration } from 'astro';

const debug = createDebug('varlock:astro-integration');
const DEFAULT_PUBLIC_DYNAMIC_ENDPOINT = '/__varlock/public-env';
const PUBLIC_DYNAMIC_ROUTE_ENTRYPOINT = fileURLToPath(
  new URL('./public-dynamic-env-route.js', import.meta.url),
);

debug('Loaded varlock astro integration file');

interface VarlockAstroPublicDynamicEndpointOptions {
  /** Route path for public dynamic values */
  path?: string,
}

export interface VarlockAstroIntegrationOptions extends VarlockVitePluginOptions {
  /**
   * Inject a route that returns `getPublicDynamicEnv()`.
   * - `undefined`: auto (enabled only when dynamic+public config exists)
   * - `true`: always enabled at `DEFAULT_PUBLIC_DYNAMIC_ENDPOINT`
   * - `false`: disabled
   * - object: enabled with custom options
   */
  publicDynamicEndpoint?: boolean | VarlockAstroPublicDynamicEndpointOptions,
}

function hasDynamicPublicConfigInSchema(cwd?: string): boolean {
  try {
    const { stdout } = execSyncVarlock('load --format json-full --compact', {
      fullResult: true,
      ...(cwd && { cwd }),
    });
    const loadedEnv = JSON.parse(stdout) as SerializedEnvGraph;
    return Object.values(loadedEnv.config || {}).some((itemInfo) => itemInfo.isDynamic && !itemInfo.isSensitive);
  } catch (err) {
    debug('Failed to auto-detect dynamic+public config, defaulting to endpoint enabled', err);
    // Fail open in auto mode so the endpoint remains available.
    return true;
  }
}

function shouldInjectPublicDynamicEndpoint(
  option: VarlockAstroIntegrationOptions['publicDynamicEndpoint'],
  cwd?: string,
): boolean {
  if (option === false) return false;
  if (option === true || typeof option === 'object') return true;
  // Auto mode: only inject when dynamic+public keys exist.
  return hasDynamicPublicConfigInSchema(cwd);
}

function resolvePublicDynamicEndpointPath(
  option: VarlockAstroIntegrationOptions['publicDynamicEndpoint'],
  cwd?: string,
): string | null {
  if (!shouldInjectPublicDynamicEndpoint(option, cwd)) return null;
  const configuredPath = (typeof option === 'object' && option.path) || DEFAULT_PUBLIC_DYNAMIC_ENDPOINT;
  if (!configuredPath.startsWith('/')) {
    throw new Error('[varlock] `publicDynamicEndpoint.path` must start with "/"');
  }
  return configuredPath;
}

function varlockAstroIntegration(
  integrationOptions?: VarlockAstroIntegrationOptions,
): AstroIntegration {
  const {
    publicDynamicEndpoint,
    ...vitePluginOptions
  } = integrationOptions ?? {};

  return {
    name: 'varlock-astro-integration',
    hooks: {
      'astro:config:setup': ({ command, config, injectRoute }) => {
        const routePath = resolvePublicDynamicEndpointPath(publicDynamicEndpoint, fileURLToPath(config.root));
        if (!routePath) return;

        // Server-only route handlers are not supported in static production builds.
        // We still inject during `astro dev`, so local development stays consistent.
        if (command === 'build' && config.output !== 'server') {
          debug(
            `Skipping "${routePath}" injection for static build output. Set output="server" to enable dynamic public env route.`,
          );
          return;
        }

        injectRoute({
          pattern: routePath,
          entrypoint: PUBLIC_DYNAMIC_ROUTE_ENTRYPOINT,
          prerender: false,
        });
      },

      // docs say to use astro:config:setup hook to adjust vite config
      // but we wait to until here because we don't know the adapter yet
      // and we want to use that to infer ssrInjectMode
      'astro:config:done': async (opts) => {
        const adapterName = opts.config.adapter?.name;

        let ssrInjectMode = vitePluginOptions.ssrInjectMode;
        if (['@astrojs/netlify', '@astrojs/vercel', '@astrojs/cloudflare'].includes(adapterName || '')) {
          ssrInjectMode ??= 'resolved-env';
        } else if (adapterName === '@astrojs/node') {
          ssrInjectMode ??= 'auto-load';
        }

        opts.config.vite.plugins ||= [];
        opts.config.vite?.plugins?.push(
          varlockVitePlugin({
            ...vitePluginOptions,
            ssrInjectMode,
          }) as any,
        );
      },

      // Scan generated static HTML files for leaked secrets after build.
      // SSR responses are already protected by the Vite plugin's
      // patchGlobalServerResponse(), but static output written to disk
      // needs explicit scanning.
      'astro:build:done': async ({ dir }) => {
        if (varlockSettings.preventLeaks === false) return;

        const outDir = fileURLToPath(dir);
        debug('scanning build output for leaks in', outDir);

        const leakedFiles: Array<string> = [];
        for await (const file of fs.promises.glob(`${outDir}/**/*.html`)) {
          const fileContents = await fs.promises.readFile(file, 'utf8');
          try {
            scanForLeaks(fileContents, { method: 'astro post-build scan', file });
          } catch (_err) {
            leakedFiles.push(file);
          }
        }

        if (leakedFiles.length > 0) {
          throw new Error(
            `Build aborted: ${leakedFiles.length} file(s) contain leaked sensitive config`,
          );
        }
      },
    },
  };
}

export default varlockAstroIntegration;
