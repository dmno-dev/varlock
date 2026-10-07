---
varlock: patch
---

Fix redaction of `--include-internal` values in `varlock run`, and warn when a sensitive number is injected, since numbers are never redacted
