---
"@varlock/cloudflare-integration": patch
---

The deprecated `varlockSvelteKitCloudflarePlugin` now uses the same adapter detection as `varlockVitePlugin()` (fixing `vite dev` on adapter-cloudflare 8) and logs a deprecation warning
