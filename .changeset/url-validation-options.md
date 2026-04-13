---
"varlock": patch
"vscode-plugin": patch
"env-spec-parser": patch
---

Add `noTrailingSlash` and `matches` (regex) options to the `url` data type. The `matches` option accepts both a plain regex string and the `regex("pattern")` wrapper syntax (e.g. `@type=url(matches=regex("^https://api\."))`), forward-compatible with a future regex language primitive.
