import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { execSyncVarlock } from 'varlock/exec-sync-varlock';
import type { PluginConfig, WorkerConfig } from '@cloudflare/vite-plugin';
import { CLOUDFLARE_SSR_ENTRY_CODE } from './shared-ssr-entry-code';

/** Name exposed by `@cloudflare/vite-plugin`'s main plugin object. */
const CLOUDFLARE_PLUGIN_NAME = 'vite-plugin-cloudflare';

export interface VarlockCloudflareOptions {
  /**
   * Automatically inject `@cloudflare/vite-plugin` into the plugin graph.
   *
   * Default: auto-detected — `false` when `@sveltejs/kit` is detected in the
   * project's `package.json` (SvelteKit is incompatible with
   * `@cloudflare/vite-plugin` — see
   * https://github.com/cloudflare/workers-sdk/issues/8922), otherwise `true`.
   */
  injectCloudflareVitePlugin?: boolean;

  /**
   * Additional virtual module IDs to treat as SSR entry points for env-loader
   * injection. Purely additive — appended to whatever the plugin auto-targets
   * (the virtual Cloudflare worker entry when `@cloudflare/vite-plugin` is
   * injected; otherwise default SSR entry detection handles it).
   *
   * Forwarded to `@varlock/vite-integration`'s `ssrEntryModuleIds` option.
   *
   * Advanced escape hatch for polyglot setups where your framework exposes
   * additional virtual entry modules that should also get the env loader.
   */
  ssrEntryModuleIds?: Array<string>;
}

/**
 * Options for `varlockCloudflareVitePlugin`.
 *
 * Top-level fields are forwarded to `@cloudflare/vite-plugin`. Varlock-specific
 * flags live under the `varlock` key.
 */
export type VarlockCloudflareVitePluginOptions = PluginConfig & {
  varlock?: VarlockCloudflareOptions;
};

/**
 * Heuristic: does the nearest `package.json` list `@sveltejs/kit` as a dep?
 *
 * Used to auto-decide `injectCloudflareVitePlugin` — SvelteKit doesn't work
 * with `@cloudflare/vite-plugin`, so when it's present we skip injection and
 * use the SSR-entry strategy that targets SvelteKit's server bundle instead.
 */
function hasSvelteKitInstalled(cwd = process.cwd()): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return '@sveltejs/kit' in deps;
  } catch {
    return false;
  }
}

/**
 * Varlock Cloudflare Vite plugin.
 *
 * Wires varlock into a Vite project that deploys to Cloudflare Workers. In the
 * default (Workers) flow it wraps `@cloudflare/vite-plugin` with automatic env
 * var injection. For SvelteKit + `@sveltejs/adapter-cloudflare` projects the
 * plugin auto-detects SvelteKit and adjusts: it skips injecting
 * `@cloudflare/vite-plugin` and uses a guarded SSR-entry loader that is safe
 * to evaluate in Node during postbuild.
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
 *
 * @example Force a specific behavior (e.g. in unusual setups)
 * ```ts
 * varlockCloudflareVitePlugin({
 *   // top-level options are forwarded to @cloudflare/vite-plugin
 *   configPath: './custom-wrangler.toml',
 *   varlock: {
 *     injectCloudflareVitePlugin: false,
 *   },
 * });
 * ```
 */
export function varlockCloudflareVitePlugin(
  options?: VarlockCloudflareVitePluginOptions,
  // Return Array<any> instead of Array<Plugin> to avoid symlink type conflicts.
  // When this package is symlinked for local dev, TypeScript resolves `vite`'s
  // Plugin type from this package's node_modules — a different copy than the
  // consumer's — causing spurious type errors. Since Vite's `plugins` config
  // is loosely typed, Array<any> is functionally equivalent.
): Array<any> {
  const { varlock: varlockOpts, ...cloudflareOptions } = options ?? {};

  // --- feature resolution (per-feature auto-detection) -----------------
  const detectedSvelteKit = hasSvelteKitInstalled();
  const injectCfPlugin = varlockOpts?.injectCloudflareVitePlugin ?? !detectedSvelteKit;

  // --- conflict guard ---------------------------------------------------
  // Error loudly if the user added `@cloudflare/vite-plugin` themselves.
  // When we inject, we expect exactly one instance (ours); when we don't
  // inject, we expect zero.
  const conflictGuard: import('vite').Plugin = {
    name: 'varlock-cloudflare-conflict-guard',
    configResolved(config) {
      const cfPluginCount = config.plugins.filter(
        (p) => typeof p?.name === 'string' && p.name === CLOUDFLARE_PLUGIN_NAME,
      ).length;
      const expected = injectCfPlugin ? 1 : 0;
      if (cfPluginCount > expected) {
        throw new Error(
          '[varlock] `@cloudflare/vite-plugin` is already present in your Vite plugins. '
          + 'Remove it — `varlockCloudflareVitePlugin` injects (and configures) it for you. '
          + 'If you intentionally want to manage the Cloudflare plugin yourself, pass '
          + '`{ varlock: { injectCloudflareVitePlugin: false } }`.',
        );
      }
    },
  };

  // --- SSR entry injection ---------------------------------------------
  // The injected env loader is always the same guarded form (dynamic import
  // behind a `navigator.userAgent === 'Cloudflare-Workers'` check) so it's
  // safe regardless of whether the target module also gets evaluated by Node
  // during a framework's postbuild passes.
  //
  // The target list is auto-targeted based on `injectCfPlugin` — when we
  // inject @cloudflare/vite-plugin we explicitly add its virtual worker entry
  // (which has no file extension and thus can't be picked up by default entry
  // detection); otherwise default detection handles the framework's SSR entry.
  // Callers can append additional module IDs via `ssrEntryModuleIds`.
  const baseEntryModuleIds = injectCfPlugin
    ? ['\0virtual:cloudflare/worker-entry']
    : [];
  const extraEntryModuleIds = varlockOpts?.ssrEntryModuleIds ?? [];
  const varlockPlugin = varlockVitePlugin({
    ssrEdgeRuntime: true,
    ssrEntryCode: [CLOUDFLARE_SSR_ENTRY_CODE],
    ...(baseEntryModuleIds.length || extraEntryModuleIds.length
      ? { ssrEntryModuleIds: [...baseEntryModuleIds, ...extraEntryModuleIds] }
      : {}),
  });

  // --- path A: no cloudflare plugin (SvelteKit + adapter-cloudflare) ---
  if (!injectCfPlugin) {
    // Mark `cloudflare:workers` external so Rollup preserves our runtime
    // import. Normally `@cloudflare/vite-plugin` handles this — we need to
    // reproduce it when we're not using it.
    const externalizeCloudflareWorkers: import('vite').Plugin = {
      name: 'varlock-cloudflare-externalize-workers',
      enforce: 'pre',
      config() {
        return {
          build: {
            rollupOptions: {
              external: ['cloudflare:workers'],
            },
          },
        };
      },
    };
    return [conflictGuard, externalizeCloudflareWorkers, varlockPlugin];
  }

  // --- path B: inject cloudflare plugin --------------------------------
  // `@cloudflare/vite-plugin` is required lazily so SvelteKit consumers
  // (who take path A) don't need it installed even though it's an optional
  // peer dep of this package.
  let cloudflare: typeof import('@cloudflare/vite-plugin').cloudflare;
  try {
    const require = createRequire(import.meta.url);
    cloudflare = require('@cloudflare/vite-plugin').cloudflare;
  } catch {
    throw new Error(
      '[varlock] `@cloudflare/vite-plugin` is required when `injectCloudflareVitePlugin` is enabled. '
      + 'Install it, or pass `{ varlock: { injectCloudflareVitePlugin: false } }` if you\'re on '
      + 'SvelteKit + `@sveltejs/adapter-cloudflare` (or otherwise handling the Cloudflare plugin yourself).',
    );
  }

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
  const userConfig = cloudflareOptions.config;
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
