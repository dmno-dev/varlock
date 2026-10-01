---
varlock: patch
---

Fix the native helper failing with EACCES when varlock runs from a directory the current user cannot enter, such as after `runuser` to a service user from a private home directory. This broke `varlock cache clear` in the standalone binary.
