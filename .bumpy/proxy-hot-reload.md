---
varlock: patch
---

`varlock proxy reload` hot-reloads a running proxy without a restart.

After editing your schema, run `varlock proxy reload` from a trusted terminal to re-resolve it in the proxy's trusted context and swap the live policy (rules, injected secrets, egress mode) without restarting or dropping your agent's connection. A reload requested from inside the proxied agent is refused and logged, so an agent can't self-approve its own schema edit. Set the posture with `@proxyConfig={reload="off"|"manual"|"auto"}` (default `auto`, which enables it only for an interactive `proxy start`) or override per run with `--allow-reload` / `--no-allow-reload`. On a shared uid this is a bar-raiser, not a hard boundary, so pair it with a sandbox.
