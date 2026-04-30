---
"@varlock/1password-plugin": minor-isolated
---

Add bridge mode for devcontainer / remote environments.

The 1Password CLI normally can't reach the host's desktop app from inside a devcontainer, forcing users to fall back to service account tokens. This adds a `varlock-op-bridge` binary (shipped with the plugin) that runs on the host and proxies `op` invocations over TCP or Unix socket. The plugin detects `VARLOCK_OP_BRIDGE_SOCKET` and routes through the bridge transparently — so `op` doesn't even need to be installed inside the container, and host biometric auth still works.

- New `varlock-op-bridge` CLI with `serve` and `ensure` subcommands (idempotent, suitable for devcontainer `initializeCommand`)
- Token-based auth (32-byte random token rotated per `ensure`, 0600 on host, bind-mounted read-only into the container)
- Supports TCP (`--addr host:port`) and Unix socket (`--addr /path.sock`); TCP recommended for Docker Desktop on macOS
