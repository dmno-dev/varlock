---
varlock: minor
---

Add `@redactLogs={stdout=true}` to redact `process.stdout`/`process.stderr` writes (and `Bun.write` to them) in `varlock/auto-load` and framework integrations, using the same non-TTY rule as `varlock run`. Opt-in for now; planned to become the default in the next major. Also speeds up the partial-match check used by streaming redaction, and fixes `revealSensitiveConfig()`, which printed its 👁 markers around the value and did not work under Bun.
