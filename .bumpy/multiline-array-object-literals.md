---
"@env-spec/parser": minor
varlock: minor
---

Object and array literals can now span multiple lines. Inside decorators each continuation line is prefixed with `#` (like multi-line function calls), e.g. a long `@import(./.env.shared, pick=[ ... ])` key list; literals nested in item-value function calls use plain newlines. Single-line literals are unchanged.
