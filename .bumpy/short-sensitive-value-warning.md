---
varlock: minor
---

Warn when a sensitive value is short enough to collide with ordinary text, since redaction replaces it wherever it appears. Acknowledge with `@sensitive={allowShortValue=true}`. Also fixes sensitive values that are not strings (a numeric PIN or account id) being shown unredacted in CLI output.
