---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn, and values under 3 characters are an error that `@sensitive={allowShortValue=true}` cannot silence. A boolean carries no secret, and a number is never redacted at all, so an explicit `@sensitive` on either is an error, and one that came from `@defaultSensitive` warns; for a number, make it a string to keep leading zeros and precision. Composite values are checked per element, since redaction registers each element on its own. An explicit `@sensitive` on the `@currentEnv` item, and any non-sensitive value containing a sensitive one, are also errors. Also fixes sensitive values that are not strings, and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
