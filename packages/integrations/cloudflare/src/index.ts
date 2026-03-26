import { varlockVitePlugin, resolvedEnvVars } from '@varlock/vite-integration';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { cloudflare } from '@cloudflare/vite-plugin';
import type { Plugin } from 'vite';

/**
 * Varlock Cloudflare Vite plugin — wraps the Cloudflare Workers Vite plugin
 * with automatic env var injection.
 *
 * @example
 * ```ts
 * import { varlockCloudflareVitePlugin } from '@varlock/cloudflare-integration';
 *
 * export default defineConfig({
 *   plugins: [
 *     varlockCloudflareVitePlugin(),
 *   ],
 * });
 * ```
 */
export function varlockCloudflareVitePlugin(
  /**
   * all options from original cloudflare vite plugin are supported
   * @see https://developers.cloudflare.com/workers/vite-plugin/reference/api/
   *
  */
  cloudflareOptions?: Record<string, any>,
): Array<Plugin | Array<Plugin>> {
  // detect dev vs build — set by a pre-enforce plugin before the cloudflare
  // plugin evaluates its config callback
  let isDevMode = false;

  const modeDetector: Plugin = {
    name: 'varlock-cloudflare-mode',
    enforce: 'pre',
    config(_config, env) {
      isDevMode = env.command === 'serve';
    },
  };

  // merge our config callback with any user-provided config
  const userConfig = cloudflareOptions?.config;
  const mergedConfig = (cfg: any) => {
    // apply user's config first (static object or function)
    let userResult: any;
    if (typeof userConfig === 'function') {
      userResult = userConfig(cfg);
    } else if (userConfig) {
      userResult = userConfig;
    }

    // only inject vars in dev — production gets them via varlock-wrangler deploy
    if (!isDevMode) return userResult;

    // inject resolved vars into miniflare bindings
    const vars = resolvedEnvVars();
    // also inject __VARLOCK_ENV so initVarlockEnv() can load the full graph
    const serializedGraph = execSyncVarlock('load --format json-full --compact');
    return {
      ...userResult,
      vars: {
        ...cfg.vars, ...userResult?.vars, ...vars, __VARLOCK_ENV: serializedGraph,
      },
    };
  };

  const varlockPlugin = varlockVitePlugin({
    ssrEdgeRuntime: true,
    ssrEntryModuleIds: ['\0virtual:cloudflare/worker-entry'],
    ssrEntryCode: [
      // read the resolved env from Cloudflare's secret bindings at runtime
      // the __VARLOCK_ENV secret is uploaded via `varlock-wrangler deploy`
      "import { env as __cfEnv } from 'cloudflare:workers';",
      'if (__cfEnv?.__VARLOCK_ENV) {',
      '  globalThis.__varlockLoadedEnv = JSON.parse(__cfEnv.__VARLOCK_ENV);',
      '}',
    ],
  });

  const cloudflarePlugin = cloudflare({
    ...cloudflareOptions,
    config: mergedConfig,
  });

  return [
    modeDetector,
    varlockPlugin,
    // cloudflare() may return a single plugin or an array
    ...(Array.isArray(cloudflarePlugin) ? cloudflarePlugin : [cloudflarePlugin]),
  ];
}
