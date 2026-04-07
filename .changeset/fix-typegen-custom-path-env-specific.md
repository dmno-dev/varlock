---
"varlock": patch
---

Fix `@generateTypes` not creating variables when using a custom path with `varlock typegen --path <file>`

When a schema file with an environment-qualifier-like name (e.g. `.env.infra.schema`) was passed as the explicit entry point via `--path`, its variables were being excluded from type generation. The filename was parsed such that `infra` was treated as an environment name (`applyForEnv='infra'`), causing the data source to be marked as environment-specific and all its variables to be filtered out.

The fix ensures that a file loaded as the root entry point (no parent data source) is never treated as environment-specific, even if its filename contains an environment qualifier.
