---
"@varlock/cloudflare-integration": patch
---

Fix `auxiliaryWorkers` support in `varlockCloudflareVitePlugin`. Every worker in a multi-worker dev/preview session now receives varlock's resolved env, instead of auxiliary workers crashing on boot with `initVarlockEnv failed`. The `.dev.vars` conflict check now covers each worker's config directory too, so a stray `.dev.vars` beside an auxiliary worker can no longer silently override varlock's values.
