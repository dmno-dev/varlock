---
varlock: patch
---

Proxy: attaching `proxy run` now adopts the running session's env.

When `varlock proxy run` attaches to a running `proxy start` daemon for the directory, it now fetches the child-view env (placeholders, non-secret values, omitted keys) directly from the daemon instead of re-resolving the schema itself. Attaching no longer triggers a second unlock prompt, and the session's own overrides and env selection apply to the child, so attaching from a shell with different env vars can no longer produce a mismatched env.
