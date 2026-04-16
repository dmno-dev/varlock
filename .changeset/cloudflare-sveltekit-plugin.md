---
"@varlock/cloudflare-integration": minor
---

Support SvelteKit + `@sveltejs/adapter-cloudflare` projects in `varlockCloudflareVitePlugin`

The existing `varlockCloudflareVitePlugin` now auto-detects SvelteKit (via `@sveltejs/kit` in `package.json`) and adjusts its behavior for it: it skips injecting `@cloudflare/vite-plugin` (which isn't SvelteKit-compatible — see [cloudflare/workers-sdk#8922](https://github.com/cloudflare/workers-sdk/issues/8922)) and injects the Cloudflare Workers env loader into SvelteKit's SSR entry instead. The loader is guarded by a `navigator.userAgent` check so SvelteKit's Node-side postbuild steps (prerender, fallback) don't fail resolving the `cloudflare:workers` import. At runtime in Workers, varlock reads the resolved env from the `__VARLOCK_ENV` binding uploaded by `varlock-wrangler deploy`.

Individual features can be toggled via a new `varlock` options key, e.g. `varlockCloudflareVitePlugin({ varlock: { injectCloudflareVitePlugin: false, ssrEntryStrategy: 'host-entry-guarded' } })`. When the user has already added `@cloudflare/vite-plugin` to their Vite config, the plugin now errors with a clear message instead of silently double-registering.
