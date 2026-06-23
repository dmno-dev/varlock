---
"@varlock/vite-integration": minor
"@varlock/cloudflare-integration": patch
---

SvelteKit on Cloudflare now works with the standard varlockVitePlugin() — it auto-detects the @sveltejs/adapter-cloudflare adapter (configured in svelte.config.js or inline in vite.config) and injects the Workers env loader automatically. The same import now works across all deploy targets. varlockSvelteKitCloudflarePlugin is deprecated; install @varlock/cloudflare-integration alongside the vite plugin for Cloudflare deploys.
