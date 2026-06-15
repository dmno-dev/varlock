---
varlock: minor
env-spec-language: patch
---

`@setValuesBulk` supports key filters.

Filter which keys get injected with `pick` (allowlist) or `omit` (denylist) array args: `@setValuesBulk(opLoadEnvironment(env-id), pick=[API_KEY, DB_*])` or `@setValuesBulk(infisicalBulk(), omit=[LEGACY_TOKEN])`. By default every key is injected; `pick` and `omit` can't be combined. Both accept simple globs (`*`, `?`).
