---
"@env-spec/parser": minor
varlock: minor
env-spec-language: patch
---

A regex pattern containing a comma, space, or `)` can be written as a quoted literal, slashes and flags included: `matches="/^[0-9a-f]{7,40}$/i"`. Unquoted, those characters end the value, and the error you get now says so. `regex()` also takes optional flags as a second argument now, and rejects a `/.../` literal rather than silently compiling a pattern that matches the slashes.
