---
"varlock": minor
---

Add conditional imports with `enabled` parameter

The `@import()` decorator now supports an optional `enabled` parameter that allows conditional loading of env files based on boolean expressions.

**New features:**
- Static boolean values: `enabled=true`, `enabled=false`
- Dynamic conditions using functions: `enabled=eq($ENV, "dev")`
- Works with complex expressions: `enabled=not(eq($VAR, "value"))`
- Compatible with `forEnv()` and other resolver functions
- Supports partial imports with conditions: `@import(./.env.dev, KEY1, KEY2, enabled=...)`

**Example usage:**
```env-spec
# @import(./.env.dev, enabled=eq($ENV, "dev"))
# @import(./.env.prod, enabled=eq($ENV, "prod"))
# ---
ENV=dev
```

The system automatically handles early resolution of any variables referenced in the `enabled` condition, ensuring they are evaluated before the import decision is made.
