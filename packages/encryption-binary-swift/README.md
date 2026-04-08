# @varlock/encryption-binary-swift

macOS native binary for varlock's local encryption, built in Swift.

## Why Swift?

Varlock uses the **Secure Enclave** for hardware-backed key storage on macOS. The Secure Enclave, Touch ID biometric prompts, and native UI (status bar menu, secure input dialogs) are only accessible through Apple's `Security`, `LocalAuthentication`, and `AppKit` frameworks — which are designed for Swift/Objective-C. Rust or other languages would require fragile FFI bindings with no stable C ABI to target.

The `.app` bundle format is also required for custom Touch ID icons, `LSUIElement` (menu-bar-only) behavior, and proper code signing + notarization.

Rust is planned for Windows (TPM / Windows Hello) and Linux (TPM2), where the platform APIs have C-friendly interfaces. The IPC protocol (length-prefixed JSON over a Unix socket) is the same across all platforms.

## Structure

- `swift/` — Swift Package Manager project (`VarlockEnclave` executable)
- `scripts/build-swift.ts` — Two-phase build: compile (cacheable) + bundle (mode-specific `.app` wrapping + codesign)
- `resources/` — App icon and other bundle resources

## Building

```bash
# Local dev (current arch, dev mode)
bun run build:swift:dev

# Universal binary (arm64 + x86_64, for CI)
bun run build:swift

# With signing and release metadata
bun run build:swift -- --mode release --version 1.2.3 --sign "Developer ID Application: ..."
```

Output: `packages/varlock/native-bins/darwin/VarlockEnclave.app`
