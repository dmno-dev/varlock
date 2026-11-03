import { varlockVitePlugin } from '@varlock/vite-integration';

let deprecationNoticeLogged = false;

/**
 * Varlock SvelteKit + Cloudflare Vite plugin.
 *
 * @deprecated Use `varlockVitePlugin()` from `@varlock/vite-integration`
 * instead. It auto-detects SvelteKit projects using
 * `@sveltejs/adapter-cloudflare` and wires this up automatically, so the same
 * import works whether you deploy to Node or Cloudflare. This alias remains for
 * back-compat and goes through the same auto-detection.
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
  if (!deprecationNoticeLogged) {
    deprecationNoticeLogged = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[varlock] varlockSvelteKitCloudflarePlugin is deprecated. '
      + 'Use varlockVitePlugin() from @varlock/vite-integration, which detects adapter-cloudflare on its own.',
    );
  }
  // No explicit `ssrEntryCode`: the vite plugin's SvelteKit detection injects
  // the Workers env loader into builds and skips it in `vite dev`, where SSR
  // runs in Node (adapter-cloudflare 8 emulates `cloudflare:workers` there with
  // an env that has no varlock binding).
  return [varlockVitePlugin({ isCloudflareTarget: true })];
}
