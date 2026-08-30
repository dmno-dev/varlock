# @varlock/encryption-binary-swift

macOS native binary for varlock's local encryption, built in Swift.

This package is the build system only and is not published. The built binary ships to npm through the [`@varlock/native-helper-darwin`](../native-helpers/darwin/) publishing shell (see [`packages/native-helpers/`](../native-helpers/)), and is bundled directly into the standalone CLI archives.

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

## Identity unlock sessions

Values can be encrypted to an identity key rather than straight to the device key
(see `packages/varlock/src/lib/local-encrypt/identity.ts`). The identity private key
is ECIES-wrapped to the device key, and only the daemon may unwrap it. Two enclave
keys are involved:

- the **custody key** is the existing biometric device key. It holds the wrap at rest,
  so opening a session always costs one user-presence check.
- the **session key** is created per unlock with `.privateKeyUsage` only (no presence).
  It exists solely in daemon memory: no `.keydata` file is written. At unlock the
  identity key is unwrapped once through the custody key and immediately re-wrapped
  under the session key, and only that blob is kept. Later decrypts unwrap it silently.

Ending a session scrubs the session key data, which crypto-erases every blob held under
it. Nothing is persisted, so a daemon restart loses all sessions on purpose: a
session-wrapped blob on disk plus a no-presence key would reopen silently after a
reboot, defeating the biometric gate. A restart just means the next use costs one scan.

Daemon actions (IPC protocol version 2, reported by `ping`):

| action | what it does |
| --- | --- |
| `unlock-session` | one presence check, however many key ids; records grants and returns them |
| `decrypt-v2` | decrypts a batch of v2 payloads under a live grant, no prompt |
| `list-sessions` | live grants: scope, granted keys, unlock time, remaining TTL |
| `invalidate-session` | no arguments drops everything; `sessionId` drops one session; both fields drop one grant |

Grants are keyed by (session x key), where the session comes from `SessionScoping`.
Scopes are `once`, `session`, and `duration`, and everything is capped at 12h from the
session's first unlock.

### What ends a session

Beyond the TTL and the 12h cap, a `lockOn` policy decides which system events erase a
session:

| value | erased by |
| --- | --- |
| `screenLock` | screen lock and sleep |
| `sleep` | sleep only; survives the screen locking (default) |
| `none` | nothing but TTL expiry, the hard cap, or an explicit lock |

Resolution order is per-session override, then machine config, then the built-in
default of `sleep`:

- **per-session**: `unlock-session` takes an optional `lockOn`. It is stored on the
  session, and the lock observers consult each session's own policy, so a `screenLock`
  session can be erased by the same event a `none` session in the same daemon survives.
  Re-unlocking a session is how it changes its policy.
- **machine config**: `sessions.lockOn` in the user-level config file varlock already
  keeps at `<user varlock dir>/config.json` (the same file telemetry settings use):

  ```json
  { "sessions": { "lockOn": "sleep" } }
  ```

  Read fresh at each unlock, so an edit applies to the next unlock with no restart.
  Machine-level only, never project config: a project must not get to weaken how long
  this machine holds keys. A missing file or section is not an error. A value that is
  present and unrecognized is reported on stderr and skipped, falling through to the
  next source rather than failing the unlock.

The 12h hard cap is not configurable, and an explicit lock (`invalidate-session` with no
arguments, or the menu bar Lock) always erases everything whatever the policy says.
Which macOS notification counts as which event: only `willSleepNotification` is `sleep`;
display sleep and fast user switching are `screenLock`, so a display that sleeps after a
couple of idle minutes does not read as the machine sleeping.

### Checking the single-scan unlock

The design depends on the daemon driving the biometric itself with
`LAContext.evaluatePolicy` and then handing that authenticated context to the enclave
operation, so the custody unwrap does not raise a second sheet. That is a claim about
a given machine and OS version, so it has a probe:

```bash
swift build --package-path swift
./swift/.build/debug/VarlockEnclave probe-session-unlock --key-id varlock-default
```

It needs a real Mac with enrolled biometrics and asks for exactly one scan. Nobody has
to count sheets: `LAContext.interactionNotAllowed` makes any operation that still wants
UI fail instead of showing it, so a second prompt shows up as a failed phase.

- `control-unauthenticated` must FAIL ("User interaction required"), which is what
  proves the key is presence gated and the detection works
- `handoff-unwrap-1` / `handoff-unwrap-2` must SUCCEED, proving one scan covers
  several enclave operations
- `session-key-silent-unwrap` must SUCCEED with no authentication at all

A `"verdict": "single-scan"` means the handoff holds. `"double-prompt"` means it does
not, and sessions would have to keep their key across soft locks with a daemon-enforced
re-auth instead of crypto-erasing. Verified `single-scan` on macOS 26.1 (Apple silicon).

To create a throwaway key rather than probing a real one:

```bash
./swift/.build/debug/VarlockEnclave generate-key --key-id varlock-probe-session
./swift/.build/debug/VarlockEnclave probe-session-unlock --key-id varlock-probe-session
./swift/.build/debug/VarlockEnclave delete-key --key-id varlock-probe-session
```

### End-to-end check (no human needed)

`scripts/e2e-identity-session.ts` drives the whole protocol over the real socket
against a throwaway `XDG_CONFIG_HOME`. Its custody key is created with `--no-auth`, so
the unlock finds no presence requirement and never prompts:

```bash
swift build --package-path swift
bun run scripts/e2e-identity-session.ts
```

It needs a Mac with a Secure Enclave, so it is a local check rather than a CI one.

## Structure

- `swift/` — Swift Package Manager project (`VarlockEnclave` executable)
- `swift/Sources/IdentitySessions/`: ECIES wire format and the grant table, in a library target so both are unit tested
- `scripts/build-swift.ts` — Two-phase build: compile (cacheable) + bundle (mode-specific `.app` wrapping + codesign)
- `scripts/generate-ecies-fixture.ts`: regenerates the cross-implementation ECIES vector the Swift tests pin
- `scripts/e2e-identity-session.ts`: headless end-to-end run of the identity session actions
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
