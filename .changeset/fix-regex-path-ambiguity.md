---
"@env-spec/parser": patch
"varlock": patch-isolated
---

Fix regex literal parsing ambiguity with file paths

Removed grammar-level regex literal (`/pattern/`) parsing which caused paths like `/folder/foo/bar` to be incorrectly parsed as regex patterns. Regex-like strings are now detected at runtime by specific consumers (`remap()` match values, `matches` type option) instead of at the grammar level. Unquoted strings that look like `/pattern/flags` are treated as regex in those contexts; wrap in quotes to force literal string matching.
