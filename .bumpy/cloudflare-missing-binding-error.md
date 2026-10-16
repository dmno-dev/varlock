---
"@varlock/cloudflare-integration": patch
---

Fail with a clear message when a built Worker has no __VARLOCK_ENV binding (e.g. run with plain wrangler dev or deployed with plain wrangler deploy), pointing at varlock-wrangler dev / deploy instead of the generic initVarlockEnv advice
