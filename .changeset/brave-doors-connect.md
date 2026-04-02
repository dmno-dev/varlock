---
"@varlock/1password-plugin": minor
---

Add support for 1Password Connect server (self-hosted)

- New auth mode: `connectHost` + `connectToken` parameters in `@initOp()` for connecting to self-hosted 1Password Connect servers
- Direct REST API integration — no `op` CLI or 1Password SDK required for Connect server usage
- New `opConnectToken` data type for Connect server API tokens
- Parses standard `op://vault/item/[section/]field` references and resolves them via the Connect API
- Caches vault and item ID lookups within a session for efficiency
- Clear error when `opLoadEnvironment()` is used with Connect (not supported by the Connect API)
- Updated error messages and tips to include Connect server as an auth option
