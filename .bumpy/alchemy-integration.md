---
'@varlock/alchemy-integration': minor
'@varlock/cloudflare-integration': patch
---

New `@varlock/alchemy-integration`: a [secret provider](https://alchemy.run/environments/secret-providers/) for [Alchemy](https://alchemy.run) stacks (alchemy 2.0.0-beta.85 or later). `Varlock.Secrets()` (one schema, or one per service with `services`) validates and resolves your `.env.schema` before alchemy builds providers, and feeds alchemy's `Config` reads on any platform. The `@varlock/alchemy-integration/cloudflare` adapter turns it into typed Worker bindings, including the `__VARLOCK_ENV` blob for in-Worker log redaction and leak detection. `@varlock/cloudflare-integration` now builds and reads the blob with the shared `varlock/env-blob` implementation
