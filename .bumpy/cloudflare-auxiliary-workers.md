---
"@varlock/cloudflare-integration": patch
---

Fix `auxiliaryWorkers` support in `varlockCloudflareVitePlugin`. Every worker in a multi-worker dev/preview session now receives varlock's resolved env, instead of auxiliary workers crashing on boot with `initVarlockEnv failed`.
