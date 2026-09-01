---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn, and values under 3 characters are an error that `@sensitive={allowShortValue=true}` cannot silence. A boolean carries no secret, a number is never redacted at all, and the `@currentEnv` item is a mode name rather than a secret: an explicit `@sensitive` on any of those is an error, and one that came from `@defaultSensitive` warns. For a number, make it a string to keep leading zeros and precision. Composite values are checked per element, since redaction registers each element on its own. A non-sensitive value that contains a sensitive one now warns, either because it carries a real secret into public output or because redacting the shorter value will rewrite it everywhere it appears. Also fixes sensitive values that are not strings, and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
