---
varlock: patch
---

Resolve dynamic arguments in forEnv(); a forEnv() argument that resolves to undefined is now an error instead of silently comparing against "undefined"
