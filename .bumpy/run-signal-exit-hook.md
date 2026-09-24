---
"varlock": patch
---

`varlock run` now waits for a child's shutdown handler to finish after forwarding `SIGTERM` or `SIGINT`. Previously, in published builds, varlock exited right after forwarding the signal and killed the child mid-shutdown (for example on `docker stop` with `varlock run` as the container entrypoint).
