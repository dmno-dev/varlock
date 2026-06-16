---
varlock: patch
---

Fix typed builtin vars (e.g. boolean VARLOCK_IS_CI) being stringified when referenced from root decorators like @import/@initOp, which broke not()/if() logic
