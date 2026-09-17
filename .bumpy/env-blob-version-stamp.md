---
varlock: patch
---

Serialized env blobs (`__VARLOCK_ENV`) now record the format version and the varlock version that produced them. Nothing reads these yet: they exist so future version skew between the varlock that resolved the env and the one consuming it can be detected.
