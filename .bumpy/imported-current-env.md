---
varlock: patch
---

`@currentEnv=$FLAG` can now reference a key brought in by `@import`, including a partial import that lists the flag in `pick=[...]`. Previously the flag had to be defined in the same file, which broke monorepo schemas that import a shared `DEPLOY_ENV`. A missing flag still errors, now naming the import as a way to provide it. An auto-loaded `.env` value on its own does not satisfy the flag or trigger `.env.<env>` loading. A `@currentEnv` declared in an imported file now also carries through a partial import when the flag is included in the filter. Directory imports declared before the import that provides the flag are rejected with an error asking you to reorder.
