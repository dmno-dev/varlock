---
"@varlock/bitwarden-plugin": minor
---

Add Bitwarden Password Manager and Vaultwarden support via the `bw` CLI.

New additions:
- `@initBwp()` root decorator — initializes a Password Manager instance using a `bw unlock` session token
- `bwp()` resolver function — fetches any field (password, username, notes, totp, uri, or custom field) from a vault item by name or UUID
- `bwSessionToken` data type — sensitive type for the `bw` CLI session token

This enables local-development use of Bitwarden Password Manager and self-hosted Vaultwarden vaults, which do not support machine accounts.
