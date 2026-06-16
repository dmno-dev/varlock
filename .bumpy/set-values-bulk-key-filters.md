---
varlock: minor
env-spec-language: patch
---

`@setValuesBulk` and `@import` support `pick`/`omit` key filters.

Filter which keys are brought in with `pick` (allowlist) or `omit` (denylist) array args — e.g. `@setValuesBulk(opLoadEnvironment(env-id), pick=[API_KEY, DB_*])` or `@import(./.env.shared, omit=[LEGACY_TOKEN])`. By default every key is included; `pick` and `omit` can't be combined, and both accept simple globs (`*`, `?`).

For `@import`, listing keys as positional args (`@import(./.env.shared, KEY1, KEY2)`) is now deprecated in favor of `pick=[...]` — it still works but warns.
