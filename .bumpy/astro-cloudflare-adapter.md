---
"@varlock/astro-integration": patch
"@varlock/cloudflare-integration": patch
---

Fix varlock env initialization when using the Astro Cloudflare adapter (@astrojs/cloudflare), including Astro v7. The Astro integration now injects varlock init into the Cloudflare worker entry so ENV works in astro dev and production Workers deployments. Requires `@varlock/cloudflare-integration` when using `@astrojs/cloudflare` (optional peer).
