import { varlockVitePlugin } from '@varlock/vite-integration';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';

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
   * All options from the original Cloudflare Vite plugin are supported.
   * @see https://developers.cloudflare.com/workers/vite-plugin/reference/api/
   */
  cloudflareOptions?: PluginConfig,
  // Return Array<any> instead of Array<Plugin> to avoid symlink type conflicts.
  // When this package is symlinked for local dev, TypeScript resolves `vite`'s
  // Plugin type from this package's node_modules — a different copy than the
  // consumer's — causing spurious type errors. Since Vite's `plugins` config
  // is loosely typed, Array<any> is functionally equivalent.
): Array<any> {
  // detect dev vs build — set by a pre-enforce plugin before the cloudflare
  // plugin evaluates its config callback
  let isDevMode = false;

  const modeDetector: import('vite').Plugin = {
    name: 'varlock-cloudflare-mode',
    enforce: 'pre',
    config(_config, env) {
      isDevMode = env.command === 'serve';
    },
  };

  // merge our config callback with any user-provided config
  const userConfig = cloudflareOptions?.config;
  const mergedConfig = (cfg: WorkerConfig) => {
    // apply user's config first (static object or function)
    let userResult: Partial<WorkerConfig> | undefined;
    if (typeof userConfig === 'function') {
      userResult = userConfig(cfg) || undefined;
    } else if (userConfig) {
      userResult = userConfig;
    }

    // only inject vars in dev — production gets them via varlock-wrangler deploy
    if (!isDevMode) return userResult;

    // single CLI call to get the full graph, then extract individual vars from it
    const serializedGraph = execSyncVarlock('load --format json-full --compact');
    let graph: { config: Record<string, { value: unknown }> };
    try {
      graph = JSON.parse(serializedGraph);
    } catch (err) {
      throw new Error(`[varlock] failed to parse config graph: ${(err as Error).message}`);
    }
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
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      throw new Error("[varlock] invalid __VARLOCK_ENV_CHUNKS: " + __cfEnv.__VARLOCK_ENV_CHUNKS);
    }
    const parts = [];
    for (let i = 0; i < n; i++) {
      const chunk = __cfEnv["__VARLOCK_ENV_" + i];
      if (chunk == null) throw new Error("[varlock] missing chunk __VARLOCK_ENV_" + i);
      parts.push(chunk);
    }
    __varlockEnvJson = parts.join("");
  }
  if (__varlockEnvJson) {
    try {
      globalThis.__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
    } catch (e) {
      throw new Error("[varlock] failed to parse __VARLOCK_ENV: " + e.message);
    }
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
