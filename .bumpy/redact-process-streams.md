---
varlock: minor
---

Rename `@redactLogs` to `@redact` (the old name still works as a deprecated alias, with a warning) and add `@redact={stdout=true}` to redact `process.stdout`/`process.stderr` writes (and `Bun.write` to them) in `varlock/auto-load` and framework integrations, using the same non-TTY rule as `varlock run`. Opt-in for now; planned to become the default in the next major. Also adds `@sensitive={redact=false}` to exempt a value that is meant to be printed, and speeds up the partial-match check used by streaming redaction. Fixes `revealSensitiveConfig()`, which printed its 👁 markers around the value and did not work under Bun.
