---
'@varlock/alchemy-integration': minor
'@varlock/cloudflare-integration': minor
---

New `@varlock/alchemy-integration`: a [secret provider](https://alchemy.run/environments/secret-providers/) for [Alchemy](https://alchemy.run) stacks (alchemy 2.0.0-beta.80 or later). `varlock()` (one schema) and `varlockServices()` (one schema per service) validate and resolve your `.env.schema` before alchemy builds providers, feed alchemy's `Config` reads, and expose typed Worker bindings including the `__VARLOCK_ENV` blob for in-Worker log redaction and leak detection. `@varlock/cloudflare-integration` now exports `buildVarlockEnvBlobBindings()` from `@varlock/cloudflare-integration/env-bindings` (the Worker-secret-sized form of the shared blob format) for other deploy tools
