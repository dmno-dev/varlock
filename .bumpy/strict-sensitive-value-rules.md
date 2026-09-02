---
varlock: major
---

Values that redaction cannot protect are no longer left as warnings. A number, boolean, array or object of them, or the `@currentEnv` item is now simply not sensitive when `@defaultSensitive` was what made it so, and an explicit `@sensitive` on one is an error. A sensitive value under 3 characters, and a non-sensitive value that contains a sensitive one, are errors however the item became sensitive. Demotion is decided from the schema-level type, never from a value in an environment-specific file. Note a demoted item is also `@static` by default, so a boolean read at runtime now needs an explicit `@dynamic`.
