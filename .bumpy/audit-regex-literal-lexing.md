---
varlock: patch
env-spec-language: patch
---

`varlock audit` no longer tries to lex string, template and regex literals while scanning source files. A quote inside a regex (such as `s.replace(/'/g, "")`), JSX text or a docstring could throw that lexer off and silently hide every env var reference after it in the same file. The scanner now only skips lines that are entirely comments, and references mentioned inside string literals are reported like any other.

New `@auditIgnoreKeys(KEY, PREFIX_*)` root decorator: keys the audit should never report as missing from the schema, for scanner false positives such as a `process.env.FOO` mentioned inside a string.
