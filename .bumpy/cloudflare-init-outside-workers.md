---
"@varlock/cloudflare-integration": patch
---

`@varlock/cloudflare-integration/init` no longer breaks prerendering on frameworks that run the server bundle in Node (such as Nuxt 5 / Nitro 3 with the `cloudflare_module` preset). It loads `cloudflare:workers` only inside Workers and reads the same keys from `process.env` elsewhere.
