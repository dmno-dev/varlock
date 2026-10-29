---
varlock: patch
---

Name the failing keys on the last line of output when config is invalid, so tools that only show the tail of a failed process (e.g. Kubernetes termination messages) say which vars to fix. CLI error summaries are now prefixed with `[varlock]`
