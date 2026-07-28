---
varlock: patch
---

Root decorators (@initAws, etc) now resolve the full dependency chain of items referenced in their args, instead of only the directly referenced items
