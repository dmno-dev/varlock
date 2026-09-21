---
varlock: patch
---

`varlock audit` no longer tries to lex string, template and regex literals while scanning source files. A quote inside a regex (such as `s.replace(/'/g, "")`), JSX text or a docstring could throw that lexer off and silently hide every env var reference after it in the same file. The scanner now only skips lines that are entirely comments; references mentioned inside string literals are reported like any other, and can be suppressed with `@auditIgnore`.
