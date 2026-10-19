---
varlock: minor
---

`varlock load --format json-full` now lists each item's `@tag(...)` names as `tags`, so tools consuming it (such as the new Alchemy integration) can select items by tag. New `varlock/env-blob` export (build and read the `__VARLOCK_ENV` blob bindings, with chunking and encryption) and a `filterSerializedGraphKeys()` helper on the main entry (apply a `--filter` expression to a serialized graph) for tools that deliver varlock config to a runtime
