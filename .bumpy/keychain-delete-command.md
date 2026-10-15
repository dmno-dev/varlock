---
varlock: minor
---

Add `varlock keychain delete` to remove a single macOS Keychain item

Allow `deno` processes to connect to the local encryption daemon, so `keychain()` and other daemon-backed features work when running varlock under Deno.

`keychain()` errors now say whether the item is missing, not accessible, or ambiguous, and print the exact `varlock keychain set` or `fix-access` command to fix it.

Fix `keychain("service", account="...")` and `keychain("service", keychain="...")` silently ignoring the positional service name, which could return a different item's secret.

Add `allowMissing=true` to `keychain()`, so `fallback(keychain(..., allowMissing=true), ...)` can fall through when the item is missing or the machine is not a Mac. A `keychain()` in an `if()` branch that does not run no longer fails on Linux and Windows.
