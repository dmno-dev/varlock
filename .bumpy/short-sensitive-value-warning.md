---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn, and values under 4 characters are an error. Booleans are now always treated as non-sensitive, since a boolean holds no secret but redacting it would rewrite every `true`/`false` in your output. A sensitive number is rejected (make it a string, so leading zeros and precision survive), as is an explicit `@sensitive` on the `@currentEnv` item and any non-sensitive value that contains a sensitive one. Acknowledge a legitimately short secret with `@sensitive={allowShortValue=true}`. Also fixes sensitive values that are not strings (a numeric PIN or account id), and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
