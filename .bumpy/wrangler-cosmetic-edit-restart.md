---
"@varlock/cloudflare-integration": patch
---

`varlock-wrangler dev` no longer restarts wrangler when an env file is saved with only cosmetic changes (whitespace, comments) that leave every resolved value the same
