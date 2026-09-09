---
varlock: patch
---

varlock load/run no longer spawns the native encryption helper unless encrypted values or the disk cache are actually used. Fixes multi-second startup on WSL 2 for projects with no encrypted values.
