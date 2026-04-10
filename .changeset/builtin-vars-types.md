---
"varlock": patch
---

Builtin vars now have proper types: `VARLOCK_IS_CI` is now a `boolean` (was a string `"true"`/`"false"`), and `VARLOCK_BUILD_URL` is now a `url` type. String builtin vars remain unchanged.
