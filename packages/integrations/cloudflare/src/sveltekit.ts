import { varlockVitePlugin } from '@varlock/vite-integration';
import { CLOUDFLARE_SSR_ENTRY_CODE } from './shared-ssr-entry-code';

/**
 * Varlock SvelteKit + Cloudflare Vite plugin.
 *
 * @deprecated Use `varlockVitePlugin()` from `@varlock/vite-integration`
 * instead — it now auto-detects SvelteKit projects using
 * `@sveltejs/adapter-cloudflare` and wires this up automatically, so the same
 * import works whether you deploy to Node or Cloudflare. This alias remains for
 * back-compat and simply forces the Cloudflare edge loader explicitly.
 *
 * @example
 * ```ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { varlockVitePlugin } from '@varlock/vite-integration';
 *
 * export default defineConfig({
 *   plugins: [
 *     varlockVitePlugin(),
 *     sveltekit(),
 *   ],
 * });
 * ```
 */
// Return type is `Array<any>` to avoid symlink-induced Vite Plugin type
// conflicts (see note in ./index.ts).
export function varlockSvelteKitCloudflarePlugin(): Array<any> {
  // `varlockVitePlugin` already marks `cloudflare:workers` external; here we
  // just force the edge runtime + loader explicitly (bypassing auto-detection).
  return [
    varlockVitePlugin({
      ssrEdgeRuntime: true,
      ssrEntryCode: [CLOUDFLARE_SSR_ENTRY_CODE],
    }),
  ];
}
