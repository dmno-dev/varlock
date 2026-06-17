---
varlock: patch
---

`varlock proxy refresh` now hot-reloads a running proxy daemon.

Editing your schema and running `varlock proxy refresh` re-resolves it in the daemon's trusted context and swaps the live policy — proxy rules, injected secrets, and egress mode — without restarting the proxy or dropping your agent's connection. One-shot `proxy run` sessions aren't reloadable (they already re-read the schema each invocation), and refreshing one now reports that instead of silently doing a partial update.
