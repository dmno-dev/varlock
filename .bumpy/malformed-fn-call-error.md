---
varlock: patch
---

Error when an unquoted config item value looks like a function call but cannot be parsed as one (e.g. an unquoted arg containing a space), instead of silently using the literal text
