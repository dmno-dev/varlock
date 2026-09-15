---
"@env-spec/parser": minor
varlock: minor
env-spec-language: patch
---

`regex()` now takes optional flags as a second argument: `matches=regex("^[0-9a-f]{7,40}$", "i")`. An unquoted `/pattern/` is an ordinary value, so a pattern containing a `,` (a `{7,40}` quantifier, say), a space, or a `)` has to use `regex()` - the error you get when it splits now says so. Passing a `/.../` literal to `regex()` is now an error rather than silently compiling a pattern that matches the slashes.
