---
varlock: patch
---

`varlock/auto-load` now redacts sensitive values written straight to `process.stdout` / `process.stderr` when the stream is piped or redirected, as `varlock run` already does. Set `_VARLOCK_REDACT_STDOUT=false` to opt out
