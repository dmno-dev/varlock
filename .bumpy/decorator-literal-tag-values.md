---
"@env-spec/parser": patch
---

Inside decorator function args and literals, a `#` directly followed by a letter or digit is now parsed as a value (e.g. a `#tag` selector in `@import(..., pick=[#frontend])`) instead of starting a comment. Comments still start with `# ` (hash and space) or a bare `#` at the end of a line.
