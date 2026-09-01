---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn; values under 4 characters, booleans, the `@currentEnv` item, and any value that also appears inside a non-sensitive item are now errors. Acknowledge a legitimately short secret with `@sensitive={allowShortValue=true}`. Also fixes sensitive values that are not strings (a numeric PIN or account id), and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
