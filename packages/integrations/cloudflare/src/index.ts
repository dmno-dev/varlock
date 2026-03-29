import { varlockVitePlugin } from '@varlock/vite-integration';
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

    // single CLI call to get the full graph, then extract individual vars from it
    const serializedGraph = execSyncVarlock('load --format json-full --compact');
    const graph = JSON.parse(serializedGraph) as {
      config: Record<string, { value: unknown }>,
    };
    const vars: Record<string, string> = {};
    for (const key in graph.config) {
      const { value } = graph.config[key];
      if (value === undefined) continue;
      vars[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
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
      // it may be a single binding or split into chunks if >5KB
      `
import { env as __cfEnv } from 'cloudflare:workers';
{
  let __varlockEnvJson;
  if (__cfEnv?.__VARLOCK_ENV) {
    __varlockEnvJson = __cfEnv.__VARLOCK_ENV;
  } else if (__cfEnv?.__VARLOCK_ENV_CHUNKS) {
    const n = parseInt(__cfEnv.__VARLOCK_ENV_CHUNKS, 10);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(__cfEnv["__VARLOCK_ENV_" + i]);
    __varlockEnvJson = parts.join("");
  }
  if (__varlockEnvJson) {
    globalThis.__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
  }
}
`,
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
