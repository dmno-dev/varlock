---
"@varlock/cloudflare-integration": patch
---

varlock-wrangler dev: skip watching FIFO/non-regular env sources (fixes endless no-op reload logs), and ignore spurious watch events where file mtime is unchanged
