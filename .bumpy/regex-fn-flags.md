---
"@env-spec/parser": minor
varlock: minor
env-spec-language: patch
---

`regex("pattern", "flags")` is now the one way to write a regex, and takes flags as a second argument: `matches=regex("^[0-9a-f]{7,40}$", "i")`. Reading a bare `/pattern/` string as a regex (in `matches`, `remap()` match values and `@auditExtraPatterns`) still works but is deprecated and produces a warning; a future major version will stop doing it. `regex()` also rejects a `/.../`-wrapped argument instead of silently matching the slashes.
