---
"varlock": minor-isolated
---

Add `--no-inject-graph` CLI flag to `varlock run` to opt out of injecting the `__VARLOCK_ENV` serialized config graph into the child process environment. This prevents sensitive values from being exposed via environment inspection (e.g., `env`, `printenv`) in interactive shells, long-lived processes, or LLM-driven agents.
