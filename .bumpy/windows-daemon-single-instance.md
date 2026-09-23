---
varlock: patch
---

Fix duplicate encryption daemons on Windows when many varlock processes start at once, which made each daemon ask for Windows Hello separately.
