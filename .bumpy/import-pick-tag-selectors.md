---
varlock: minor
---

`pick`/`omit` on `@import()` now accept the same selectors as `--filter`: `#tag` to import items tagged with `@tag()` in the imported file, and `!selector` to exclude matches (e.g. `pick=[#frontend, !#internal]` or `pick=[API_*, !API_SECRET]`). Previously a `#tag` entry silently matched nothing. `@setValuesBulk` `pick`/`omit` gain `!` exclusions too; decorator selectors like `@sensitive` are rejected with a clear error in both.

New `varlock.filter` option in `package.json`: a default `--filter` for `varlock load`/`run`, valid alongside `varlock.loadPath`, so a package can point at a shared root schema and take just its tagged items without a `.env.schema` of its own.
