---
varlock: minor
---

Serialized env blobs (__VARLOCK_ENV) now record the varlock version that produced them. Automatic blob reuse re-resolves when the producer version differs, and the runtime warns when env was resolved by a different varlock minor/major than the runtime code consuming it.
