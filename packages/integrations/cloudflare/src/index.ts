import { varlockVitePlugin } from '@varlock/vite-integration';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { CLOUDFLARE_SSR_ENTRY_CODE } from './shared-ssr-entry-code';

/** Name exposed by `@cloudflare/vite-plugin`'s main plugin object. */
const CLOUDFLARE_PLUGIN_NAME = 'vite-plugin-cloudflare';

/**
 * Varlock Cloudflare Vite plugin — wraps `@cloudflare/vite-plugin` with
 * automatic env var injection.
 *
 * For SvelteKit projects deploying via `@sveltejs/adapter-cloudflare`, use
 * `varlockSvelteKitCloudflarePlugin` from
 * `@varlock/cloudflare-integration/sveltekit` instead — it skips
 * `@cloudflare/vite-plugin` (which doesn't support SvelteKit) and uses an
 * SSR-entry-based env loader.
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
  // --- conflict guard ---------------------------------------------------
  // Error loudly if the user added `@cloudflare/vite-plugin` themselves.
  const conflictGuard: import('vite').Plugin = {
    name: 'varlock-cloudflare-conflict-guard',
    configResolved(config) {
      const cfPluginCount = config.plugins.filter(
        (p) => typeof p?.name === 'string' && p.name === CLOUDFLARE_PLUGIN_NAME,
      ).length;
      if (cfPluginCount > 1) {
        throw new Error(
          '[varlock] `@cloudflare/vite-plugin` is already present in your Vite plugins. '
          + 'Remove it — `varlockCloudflareVitePlugin` injects (and configures) it for you.',
        );
      }
    },
  };

  // Detect dev vs build — set by a pre-enforce plugin before the cloudflare
  // plugin evaluates its config callback.
  let isDevMode = false;
  const modeDetector: import('vite').Plugin = {
    name: 'varlock-cloudflare-mode',
    enforce: 'pre',
    config(_config, env) {
      isDevMode = env.command === 'serve';
    },
  };

  // Merge our config callback with any user-provided config.
  const userConfig = cloudflareOptions?.config;
  const mergedConfig = (cfg: WorkerConfig) => {
    let userResult: Partial<WorkerConfig> | undefined;
    if (typeof userConfig === 'function') {
      userResult = userConfig(cfg) || undefined;
    } else if (userConfig) {
      userResult = userConfig;
    }

    // Only inject vars in dev — production gets them via varlock-wrangler deploy.
    if (!isDevMode) return userResult;

    // Single CLI call for the full graph, then extract individual vars.
    const { stdout: serializedGraph } = execSyncVarlock('load --format json-full --compact', { fullResult: true });
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
    ssrEntryCode: [CLOUDFLARE_SSR_ENTRY_CODE],
  });

  const cloudflarePlugin = cloudflare({
    ...cloudflareOptions,
    config: mergedConfig,
  });

  return [
    conflictGuard,
    modeDetector,
    varlockPlugin,
    // cloudflare() may return a single plugin or an array
    ...(Array.isArray(cloudflarePlugin) ? cloudflarePlugin : [cloudflarePlugin]),
  ];
}
