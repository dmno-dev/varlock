---
"varlock": major
---

Built-in local encryption utilities - let's get everything out of plaintext!

- Add built-in `varlock()` resolver for local device-bound encryption using tiny native binaries
  - macOS via Swift/Secure Enclave
  - Windows via Windows Hello/TPM (+WSL2 support)
  - Linux via TPM2/keyring
- Add `varlock encrypt` command with stdin support
- Add `varlock reveal` command
- Add `varlock lock` command to clear local session unlock
- Add `keychain()` resolver for built-in macOS Keychain support