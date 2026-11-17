---
"@env-spec/parser": patch
---

Allow whitespace between `=` and a quoted value, function call, or literal (e.g. `A = "x"`), which previously failed to parse or fell back to a plain string
