# @varlock/encryption-binary-swift

macOS native binary for varlock's local encryption, built in Swift.

## Why Swift?

Varlock uses the **Secure Enclave** for hardware-backed key storage on macOS. The Secure Enclave, Touch ID biometric prompts, and native UI (status bar menu, secure input dialogs) are only accessible through Apple's `Security`, `LocalAuthentication`, and `AppKit` frameworks — which are designed for Swift/Objective-C. Rust or other languages would require fragile FFI bindings with no stable C ABI to target.

The `.app` bundle format is also required for custom Touch ID icons, `LSUIElement` (menu-bar-only) behavior, and proper code signing + notarization.

Rust is planned for Windows (TPM / Windows Hello) and Linux (TPM2), where the platform APIs have C-friendly interfaces. The IPC protocol (length-prefixed JSON over a Unix socket) is the same across all platforms.

## Keychain Integration

The binary includes a `keychain()` resolver that reads secrets from the macOS Keychain. This is useful for IT-managed environments where credentials are pushed to user keychains via MDM.

- **Search & read** — uses modern `SecItemCopyMatching` API (not deprecated)
- **Create items** — stores as Keychain secure notes via `SecItemAdd` (not deprecated), with plain text values
- **ACL management** — uses legacy `SecKeychainItemCopyAccess` / `SecTrustedApplicationCreateFromPath` / `SecKeychainItemSetAccess` APIs to add VarlockEnclave to an item's trusted application list

### Note on deprecated SecKeychain ACL APIs

The ACL management APIs (`SecKeychainItemCopyAccess`, `SecACLCopyContents`, `SecACLSetContents`, `SecTrustedApplicationCreateFromPath`, `SecKeychainItemSetAccess`) were deprecated in macOS 10.10 (2014) when Apple introduced the "Data Protection Keychain." Apple's modern keychain controls access via entitlements and access groups set at build time — there is no runtime API to grant another app access to a keychain item.

For our use case (programmatically granting VarlockEnclave access to items created by other apps, e.g. IT-managed credentials), the legacy APIs are the only option. Every password manager and security tool that does this uses the same deprecated APIs. Apple has kept them functional through macOS 15+ because there is no replacement.

These APIs are only used in the "select existing item" picker flow when VarlockEnclave doesn't already have access. Items created by VarlockEnclave itself (via "Create New") don't need ACL modification.

## Structure

- `swift/` — Swift Package Manager project (`VarlockEnclave` executable)
- `scripts/build-swift.ts` — Two-phase build: compile (cacheable) + bundle (mode-specific `.app` wrapping + codesign)
- `resources/` — App icon and other bundle resources

## Building

```bash
# Local dev (current arch, dev mode)
bun run build:current

# Universal binary (arm64 + x86_64, for CI)
bun run build:universal

# With signing and release metadata
bun run build:universal -- --mode release --version 1.2.3 --sign "Developer ID Application: ..."
```

Output: `packages/varlock/native-bins/darwin/VarlockEnclave.app`
