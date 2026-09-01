---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn, and values under 4 characters are an error. Booleans are now always treated as non-sensitive, since a boolean holds no secret but redacting it would rewrite every `true`/`false` in your output. Numbers are never redacted at all, so an explicit `@sensitive` on one is an error and a number swept in by `@defaultSensitive` warns; the fix is to make it a string, which also keeps leading zeros and precision. An explicit `@sensitive` on the `@currentEnv` item, and any non-sensitive value containing a sensitive one, are also errors. Acknowledge a legitimately short secret with `@sensitive={allowShortValue=true}`. Also fixes sensitive values that are not strings, and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
