---
"@varlock/1password-plugin": minor
---

Add `allowMissing` flag to `op()` and `@initOp()` - when set, missing items return `undefined` instead of throwing, enabling use with `fallback()` to supply default values
