---
varlock: patch
---

Fix refs in the `@cache` root decorator value (e.g. `@cache=if($USE_CACHE, "memory", "disabled")`) silently resolving as undefined
