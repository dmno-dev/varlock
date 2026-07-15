---
"@varlock/cloudflare-integration": patch
---

Quiet `varlock-wrangler dev` on macOS when env files are only opened/inspected: ignore `fs.watch` events with unchanged mtime, and log same-content no-op reloads only under `VARLOCK_DEBUG`.
