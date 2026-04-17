---
"@varlock/cloudflare-integration": minor
---

Add `varlockSvelteKitCloudflarePlugin` for SvelteKit + Cloudflare Workers projects

New `varlockSvelteKitCloudflarePlugin` exported from `@varlock/cloudflare-integration/sveltekit` for SvelteKit projects deploying via `@sveltejs/adapter-cloudflare`. Unlike `varlockCloudflareVitePlugin`, it does not include `@cloudflare/vite-plugin` (which doesn't support SvelteKit — see [cloudflare/workers-sdk#8922](https://github.com/cloudflare/workers-sdk/issues/8922)). Instead it injects the `cloudflare:workers` runtime env loader into SvelteKit's SSR entry and externalizes the import so Rollup preserves it in the built `_worker.js`. Non-sensitive vars and the `__VARLOCK_ENV` secret are still uploaded via `varlock-wrangler deploy`.

Also adds a conflict guard to `varlockCloudflareVitePlugin` that errors when the user has manually added `@cloudflare/vite-plugin` to avoid silent double-registration.
