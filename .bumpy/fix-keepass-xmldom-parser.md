---
"@varlock/keepass-plugin": patch
---

Fix opening KeePass databases, which failed with `errorHandler object is no longer supported`. Also defer database setup until a `kp()`/`kpBulk()` call actually runs, so an unused instance with an empty master password no longer fails the whole schema.
