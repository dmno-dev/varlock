---
varlock: patch
---

Warn when a `forEnv()` argument is not one of the `@currentEnv` enum values, with a "did you mean" hint, so a typo like `forEnv(prodution)` no longer silently never matches
