---
"@varlock/vite-integration": patch
---

Fix Astro + Cloudflare static/prerendered builds: bake resolved env into the build-time prerender worker, and stop mis-injecting SSR init code into non-entry modules during builds (REQUIRE_TLA errors)
