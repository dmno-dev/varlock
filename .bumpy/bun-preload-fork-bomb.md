---
varlock: patch
---

Fix an infinite spawn loop when `varlock/auto-load` is preloaded via bun's `bunfig.toml` and bun also serves as `node` (as in bun-only containers): the CLI process spawned by auto-load was preloaded too, and spawned another. The spawned CLI is now tagged with `__VARLOCK_CLI_CHILD` and a preloaded auto-load inside it skips resolving.
