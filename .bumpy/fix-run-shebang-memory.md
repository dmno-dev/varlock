---
varlock: patch
---

Fix varlock run OOM when child command is a bare PATH binary like node (shebang probe no longer reads the whole file)
