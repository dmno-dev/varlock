---
varlock: minor
---

Schema items that resolve to undefined are no longer injected into process.env as empty strings by auto-load, matching `varlock run` and the documented `VAR=` semantics (so `process.env.MY_VAR ?? 'fallback'` works). `varlock load --format shell` now also skips them. The new `@injectUndefinedAsEmpty` root decorator restores dotenv-style empty-string injection, and generated TS types follow it: process.env keys become always-present strings when it is enabled.
