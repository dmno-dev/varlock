---
"@varlock/vite-integration": patch
---

Fix `vite dev` 500s on SvelteKit with adapter-cloudflare 8 ("no __VARLOCK_ENV binding found"): the Workers env loader is now only injected into builds
