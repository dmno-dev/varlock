---
"@varlock/vite-integration": patch
---

Dev server restarts only re-resolve env when an env file changed or the last load failed, and startup reuses env already resolved by varlock/auto-load, so plugin resolvers run once instead of several times
