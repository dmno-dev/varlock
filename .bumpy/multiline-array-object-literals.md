---
"@env-spec/parser": minor
varlock: patch
env-spec-language: patch
---

Object and array literals can now span multiple lines. Inside decorators each continuation line is prefixed with `#` (like multi-line function calls), e.g. a long `@import(./.env.shared, pick=[ ... ])` key list; literals nested in item-value function calls use plain newlines. Single-line literals are unchanged.

Multi-line literals and function calls also support `#` comments — full-line entries can be commented out (`# # OLD_KEY,`) and individual entries annotated with trailing comments (`# KEY, # note`).

The VSCode extension's syntax highlighting now understands object/array literals (single- and multi-line) and these inline comments.
