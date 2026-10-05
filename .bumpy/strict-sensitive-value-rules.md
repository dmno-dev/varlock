---
varlock: major
---

Values that redaction cannot protect are now rejected, however the item became sensitive. A sensitive number, boolean, composite with non-string elements, or value under 3 characters is an error, as is a sensitive `@currentEnv` item and any non-sensitive value that contains a sensitive one. Previously these were warnings when `@defaultSensitive` was what made the item sensitive. Varlock errors rather than quietly treating such items as public so that the schema states explicitly which items are not secrets. Since `@defaultSensitive=true` is the default, a hand-written schema with no `@defaultSensitive` line will now fail to load on its ports and feature flags; the fix is `@defaultSensitive=false` at the top with an explicit `@sensitive` on each real secret, which is what `varlock init` generates.
