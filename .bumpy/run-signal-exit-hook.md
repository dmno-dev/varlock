---
"varlock": patch
---

`varlock run` now waits for a child's shutdown handler to finish after forwarding `SIGTERM` or `SIGINT`. Previously, in published builds, varlock exited right after forwarding the signal and killed the child mid-shutdown (for example on `docker stop` with `varlock run` as the container entrypoint). `varlock proxy run` now handles signals the same way: it forwards them to the child and waits, instead of killing it immediately, and propagates the child's real exit status. The `proxy start` daemon's shutdown cleanup is no longer cut short by the same exit hook.
