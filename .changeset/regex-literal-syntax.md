---
"varlock": minor
"vscode-plugin": patch
"env-spec-parser": minor
---

Add regex literal syntax (`/pattern/flags`) as a new language feature. Regex literals can be used anywhere `regex()` was previously used (e.g. `remap($VAR, /^dev.*/, result)`) and in type options (e.g. `@type=url(matches=/^https:\/\/.*/)`). The `regex()` function is now deprecated in favor of this more concise syntax.
