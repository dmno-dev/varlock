---
varlock: minor
---

Add `--filter` flag to `load`/`run` for selecting env vars by key/glob, `@sensitive`/`@required`, or tags (new `@tag()` item decorator). Also add a matching `filter=` arg to `@generate*` code-generation decorators, so a single schema can emit multiple generated files scoped to different subsets.
