---
"@varlock/vite-integration": patch
---

Detect `@sveltejs/adapter-cloudflare` with SvelteKit 3, which moved the resolved adapter out of `kit`, so the Workers env loader is injected without explicit options
