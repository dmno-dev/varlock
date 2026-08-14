---
varlock: patch
---

varlock flatten no longer needs to detect a workspace root - any @import path that resolves on disk is flattened, including in non-JS monorepos
