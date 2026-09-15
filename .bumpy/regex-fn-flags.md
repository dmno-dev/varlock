---
"@env-spec/parser": minor
varlock: minor
env-spec-language: patch
---

`regex("pattern", "flags")` is now the one way to write a regex, and takes flags as a second argument: `matches=regex("^[0-9a-f]{7,40}$", "i")`. Passing a pattern as a string still works but is deprecated and produces a warning showing the `regex()` call to use: a bare `/pattern/` string in `matches`, `remap()` match values or `@auditExtraPatterns`, or a plain string in `matches`. A future major version will stop reading strings as regexes. `regex()` also rejects a `/.../`-wrapped argument instead of silently matching the slashes.
