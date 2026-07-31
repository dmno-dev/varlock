---
varlock: patch
---

`varlock proxy reload` no longer requires the schema to resolve in the requesting shell: the proxy validates the edit in its own context before applying and reports failures back, so a remote broker can be reloaded with a bare provider exec
