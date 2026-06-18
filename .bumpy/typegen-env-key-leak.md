---
varlock: patch
---

Fix typegen leaking keys that exist only in a plain .env (not declared in .env.schema) into generated types. `varlock typegen` now also reports any such ignored keys.
