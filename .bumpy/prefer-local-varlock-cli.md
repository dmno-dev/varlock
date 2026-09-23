---
varlock: patch
---

Auto-load and framework integrations now always run the varlock CLI installed alongside the imported package, and only fall back to a `varlock` on PATH when there is no local install. Previously a globally installed CLI could win over the local one when an app was started directly with `node`, so the runtime library and the CLI could be different versions.
