import { varlockVitePlugin } from '@varlock/vite-integration';
import { CLOUDFLARE_SSR_ENTRY_CODE } from './shared-ssr-entry-code';

/**
 * Varlock SvelteKit + Cloudflare Vite plugin.
 *
 * For SvelteKit projects deploying to Cloudflare Workers via
 * `@sveltejs/adapter-cloudflare`. Unlike `varlockCloudflareVitePlugin`, this
 * does NOT include `@cloudflare/vite-plugin` (which doesn't currently support
 * SvelteKit — see https://github.com/cloudflare/workers-sdk/issues/8922).
 *
 * Injects the `cloudflare:workers` runtime env-loader into SvelteKit's SSR
 * entry, which is picked up by adapter-cloudflare's generated `_worker.js`.
 * Non-sensitive vars and the `__VARLOCK_ENV` secret should still be uploaded
 * via `varlock-wrangler deploy`.
 *
 * @example
 * ```ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { varlockSvelteKitCloudflarePlugin } from '@varlock/cloudflare-integration/sveltekit';
 *
 * export default defineConfig({
 *   plugins: [
 *     varlockSvelteKitCloudflarePlugin(),
 *     sveltekit(),
 *   ],
 * });
 * ```
 */
// Return type is `Array<any>` to avoid symlink-induced Vite Plugin type
// conflicts (see note in ./index.ts).
export function varlockSvelteKitCloudflarePlugin(): Array<any> {
  // Mark `cloudflare:workers` as external so Rollup keeps the runtime import
  // our `ssrEntryCode` injects into the SSR bundle. Normally
  // `@cloudflare/vite-plugin` handles this, but we're not using it here.
  const externalizeCloudflareWorkers: import('vite').Plugin = {
    name: 'varlock-sveltekit-cloudflare-external',
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

  return [
    externalizeCloudflareWorkers,
    varlockVitePlugin({
      ssrEdgeRuntime: true,
      ssrEntryCode: [CLOUDFLARE_SSR_ENTRY_CODE],
    }),
  ];
}
