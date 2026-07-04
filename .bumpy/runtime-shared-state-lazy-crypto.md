---
varlock: patch
---

Runtime fixes: env state is now shared across bundled copies of `varlock/env` (fixes stale values after env reloads when a bundler duplicates the module), and `node:crypto` is loaded lazily so the init bundles can be evaluated in edge sandboxes that lack node builtins
