---
varlock: patch
---

Proxy: harden secret isolation and fail-closed config validation.

- A proxied agent can no longer recover a secret by re-resolving the schema (`varlock load`/`printenv`/`run`): inside a proxy session every sensitive item resolves to its placeholder, and `@proxy=omit` items resolve to unset — never the real value. Detection now uses the env marker, the session token, and process ancestry together, so clearing `__VARLOCK_PROXY_CHILD` doesn't bypass the schema-fingerprint guard.
- `@proxy(...)` now rejects unknown options (e.g. a typo like `aproval=true`) and wrong-typed `block`/`approval`/`path` at load time instead of silently producing a permissive rule.
- Type-aware placeholders: `@type=url`/`email`/`uuid`/`md5` get a valid, unique placeholder so SDK format checks pass; all placeholders are unique per item.
