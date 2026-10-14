---
varlock: minor
---

Add `varlock keychain delete` to remove a single macOS Keychain item

Allow `deno` processes to connect to the local encryption daemon, so `keychain()` and other daemon-backed features work when running varlock under Deno.
