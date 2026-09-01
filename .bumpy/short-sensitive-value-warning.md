---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn, and values under 4 characters are an error. An explicit `@sensitive` on a boolean, on a number, or on the `@currentEnv` item is now rejected, as is any non-sensitive value that contains a sensitive one. Acknowledge a legitimately short secret with `@sensitive={allowShortValue=true}`. Also fixes sensitive values that are not strings (a numeric PIN or account id), and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
