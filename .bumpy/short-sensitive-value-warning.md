---
varlock: minor
---

Check that a value marked sensitive can actually be protected by redaction, which replaces it wherever it appears. Values under 12 characters warn. Values under 3 characters, booleans, numbers, composites with non-string elements, and the `@currentEnv` item are an error when you wrote `@sensitive` on the item, and a warning when `@defaultSensitive` swept it in, so nothing inherited from the default can fail a load. For a number, make it a string to keep leading zeros and precision. Composite values are checked per element, since redaction registers each element on its own. A non-sensitive value that contains a sensitive one now warns. Acknowledge a legitimately short secret with `@sensitive={allowShortValue=true}`; it does not apply under 3 characters. Also fixes sensitive values that are not strings, and the pre-coercion form of a coerced value, being shown unredacted in CLI output.
