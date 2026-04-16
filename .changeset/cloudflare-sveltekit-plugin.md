---
"@varlock/cloudflare-integration": minor
---

Add `varlockSvelteKitCloudflarePlugin` for SvelteKit projects deployed to Cloudflare Workers via `@sveltejs/adapter-cloudflare`

Importing from `@varlock/cloudflare-integration/sveltekit` gives you a Vite plugin variant that skips the `@cloudflare/vite-plugin` injection (which conflicts with SvelteKit) while still injecting the Cloudflare Workers env loader into the SvelteKit SSR entry. At runtime in Workers, varlock reads the resolved env from the `__VARLOCK_ENV` binding uploaded by `varlock-wrangler deploy`; the loader is guarded by a `navigator.userAgent` check so SvelteKit's Node-side postbuild steps (prerender, fallback) don't fail resolving the `cloudflare:workers` import.
