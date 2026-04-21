---
"@varlock/cloudflare-integration": patch
---

fix(cloudflare): debounce wrangler restarts and skip when env is unchanged

`varlock-wrangler dev` now caches the serialized resolved env graph and compares it
after each debounced watch event. Wrangler only restarts when the resolved env has
actually changed, preventing restart loops caused by spurious `fs.watch()` events
on macOS (which can emit events even when file contents are identical).
