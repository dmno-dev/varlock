---
"@varlock/keepass-plugin": minor
---

Add KeePass plugin for loading secrets from KDBX 4.0 databases.

- `kp()` resolver with `#attribute` syntax, entry name inference from key, and `customAttributesObj` for bulk custom field loading
- `kpBulk()` resolver for loading all passwords from a group via `@setValuesBulk`
- `kdbxPassword` data type for master password validation
- File mode using kdbxweb with pure WASM argon2 (no native addons, works in SEA builds)
- CLI mode via `keepassxc-cli` with dynamic `useCli` option (e.g., `useCli=forEnv(dev)`)
- Multiple database instances via `id` param
- Key file authentication support
- Add `input` option to `spawnAsync` for streaming stdin to child processes
