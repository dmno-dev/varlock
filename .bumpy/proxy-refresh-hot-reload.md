---
varlock: patch
---

`varlock proxy refresh` hot-reloads a running proxy.

Editing your schema and running `varlock proxy refresh` re-resolves it in the proxy's trusted context and swaps the live policy — rules, injected secrets, and egress mode — without restarting the proxy or dropping your agent's connection. `refresh` now blocks until the reload completes and then prints how to pick up the new variables (`varlock load` / `varlock run`). Works for both `proxy start` daemons and self-owned `proxy run` sessions.
