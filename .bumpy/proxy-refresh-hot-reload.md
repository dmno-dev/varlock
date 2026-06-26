---
varlock: patch
---

`varlock proxy refresh` hot-reloads a running proxy (opt-in).

Start a daemon with `varlock proxy start --allow-reload`, then editing your schema and running `varlock proxy refresh` re-resolves it in the proxy's trusted context and swaps the live policy — rules, injected secrets, and egress mode — without restarting the proxy or dropping your agent's connection. It is **off by default**: the reload channel is unauthenticated on a shared uid, so without this gate a same-uid agent could trigger a refresh to self-approve its own schema edit. When disabled, restart the proxy to apply schema changes.
