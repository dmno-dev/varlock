# @varlock/encryption-binary-rust

Cross-platform local encryption binary for Varlock (Windows and Linux).

This package is the build system only and is not published. The built binaries ship to npm through the `@varlock/native-helper-{linux-x64,linux-arm64,win32-x64}` publishing shells (see [`packages/native-helpers/`](../native-helpers/)), and are bundled directly into the standalone CLI archives.

Provides **NCrypt TPM-sealed** key protection on Windows when a TPM is available (with optional Windows Hello biometric), **DPAPI** as fallback, and TPM2 key protection on Linux, with a file-based plaintext fallback on both.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable)
- Platform-specific targets (if cross-compiling):
  ```sh
  # Linux musl (fully static, no glibc dependency)
  rustup target add x86_64-unknown-linux-musl
  rustup target add aarch64-unknown-linux-musl

  # Windows
  rustup target add x86_64-pc-windows-msvc
  ```
- **Linux musl builds** require `musl-tools`:
  ```sh
  # Ubuntu/Debian
  sudo apt-get install musl-tools
  ```

## Building

```sh
# Build for current platform (development)
bun run build:current

# Build for specific targets
bun run build:linux-x64     # x86_64-unknown-linux-musl
bun run build:linux-arm64   # aarch64-unknown-linux-musl
bun run build:windows-x64   # x86_64-pc-windows-msvc
bun run build:windows-arm64 # aarch64-pc-windows-msvc
```

Output goes to `packages/varlock/native-bins/<platform>/`.

Binaries ship uncompressed. Do not reintroduce UPX (or any other executable packer): packed binaries reliably trip generic antivirus ML detections such as Defender's `Wacatac.C!ml`, and they save nothing on the wire because npm tarballs are already gzipped (packed data does not compress further). See [#810](https://github.com/dmno-dev/varlock/issues/810) and [#1002](https://github.com/dmno-dev/varlock/issues/1002).

## Architecture

- `src/main.rs`: CLI interface (generate-key, encrypt, decrypt, status, daemon)
- `src/crypto.rs`: ECIES encryption using pure Rust crates (no OpenSSL)
- `src/key_store/`: Platform-specific key protection:
  - `windows_tpm.rs`: NCrypt TPM seal (Platform Crypto Provider)
  - `windows.rs`: DPAPI fallback
  - `windows_hello.rs`: Windows Hello presence gate (daemon)
  - `linux.rs`: TPM2 via tpm2-tools
  - `scalar.rs`: shared P-256 scalar ↔ PKCS8 helpers
- `src/identity_sessions/`: identity-backed unlock sessions (see below)
- `src/secure_mem.rs`: locked, dump-excluded, zeroize-on-drop buffers
- `src/daemon.rs`: Long-lived IPC daemon for biometric session caching
- `src/ipc.rs`: IPC server (Unix socket on Linux, named pipe on Windows)
- `src/daemon_client.rs`: Named pipe client for `--via-daemon` mode (WSL2 support)

## Identity sessions

Values are encrypted to an identity key rather than straight to the device key:

```
device key (NCrypt/TPM, DPAPI, TPM2, Secret Service) -> identity key -> values
```

The daemon holds the unwrapped identity key on behalf of one session so a whole
env file resolves without a prompt per value. A grant is what makes that holding
legitimate. The ops are the same ones the macOS (Swift) daemon speaks, so a
client cannot tell the two apart:

- `unlock-session`: open or extend a session's hold on one or more keys
- `decrypt-v2`: decrypt a batch of identity payloads under a live grant
- `list-sessions`: every live grant, with no key material
- `invalidate-session`: drop everything, one session, or one grant

`ping` reports `protocolVersion: 3`.

Rules worth knowing:

- A grant is keyed by (session x key). The session is resolved from the
  connecting process, never from anything in the message.
- Scopes are `once`, `session`, and `duration`, all capped at 12 hours.
- Deadlines are held on both the wall clock and a sleep-inclusive monotonic
  clock, and whichever runs out first ends the grant.
- Every authorization is appended to `<user varlock dir>/audit/authorizations.jsonl`
  and read back off disk before any plaintext is returned. A decrypt whose record
  cannot be written is refused.
- Nothing is persisted. A daemon restart loses every session on purpose.

### What ends a session early

`lockOn` is `screenLock`, `sleep` (the default), or `none`, taken from the
unlock, then from `sessions.lockOn` in the user config file, then from the
default. The daemon's ready line reports which triggers it actually wired:

| event | Windows | Linux |
| --- | --- | --- |
| `sleep` | `PowerRegisterSuspendResumeNotification` | logind `PrepareForSleep` |
| `screenLock` | `WTSRegisterSessionNotification` | logind session `Lock` |

Desktop-environment screensaver locks on Linux (GNOME, KDE) do not always reach
logind, and are not yet wired. A machine with no source for an event runs its
sessions to their TTL instead, and says so on stderr at startup.

### Where the key is held

macOS re-wraps the identity key under a per-session Secure Enclave key. Neither
NCrypt nor TPM2 gives a cheap equivalent, so the hold here is guarded memory: a
fixed-size allocation that never grows, `mlock`/`VirtualLock`ed, marked
`MADV_DONTDUMP` on Linux, and zeroized when the session ends. The daemon also
disables core dumps and clears `PR_SET_DUMPABLE` on Linux at startup. A
TPM-resident session key is a later step.

## WSL2 Support

When running from WSL2, the TypeScript side calls this Windows `.exe` directly (WSL2 can execute Windows binaries via binfmt_misc).

- `decrypt --via-daemon` routes requests through a Windows named-pipe daemon for biometric session caching.
- The WSL caller prestarts the daemon from native PowerShell and then polls readiness via `ping-daemon` before the first decrypt. This avoids first-invocation startup timeouts.
- `start-daemon` remains available for manual troubleshooting from native Windows terminals.

### WSL2 manual test checklist

After changes to Windows key storage or daemon behavior, verify:

1. **Native Windows + Hello + TPM:** `varlock-local-encrypt status` shows `hardwareBacked: true`; decrypt prompts Hello; warm session skips re-prompt for ~5 min
2. **WSL2 decrypt:** from a Linux shell, `varlock run` / load path triggers fingerprint via Windows UI; `--via-daemon` path unchanged
3. **Cold WSL start:** no daemon running → first decrypt prestarts via PowerShell → succeeds
4. **Auto-rewrap:** existing DPAPI keys upgrade to `ncrypt` on the next decrypt (no `.env` changes)

## Native helper commands

The `varlock-local-encrypt` binary (bundled with varlock on Windows/Linux) exposes additional commands:

```powershell
# Optional: re-wrap without decrypting (normally happens automatically on decrypt)
varlock-local-encrypt rewrap-key --key-id varlock-default

# Check platform capabilities
varlock-local-encrypt status
```

## CI

Binaries are built in CI via `.github/workflows/build-native-rust.yaml` on native runners for each platform. Linux targets use musl for fully static binaries that work on any Linux distribution. No platform is UPX-compressed.

### Windows Authenticode signing (maintainers)

CI signs the Windows `.exe` with [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/) when GitHub secrets and variables are configured. Without them, the build continues unsigned and logs a skip message.

Signed builds reduce Windows Defender false positives (`Wacatac.C!ml` and similar ML detections on unsigned helpers). You can also [submit a false-positive report](https://www.microsoft.com/en-us/wdsi/filesubmission) to Microsoft while rolling out signing.

#### Setup walkthrough

**1. Azure prerequisites**

- An Azure subscription ([create one free](https://azure.microsoft.com/free/) if needed)
- Your organization must be eligible for Artifact Signing identity verification (USA, Canada, EU, or UK — see [Microsoft's code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options))

**2. Create Artifact Signing resources**

In the [Azure portal](https://portal.azure.com):

1. Search for **Artifact Signing** and create an **Artifact Signing account** (pick a region — note it for step 5)
2. Inside the account, create a **Certificate profile** (e.g. `varlock-public`)
3. Complete **identity verification** when prompted (may take a few business days)
4. Note these values:
   - **Endpoint** — `https://<region>.codesigning.azure.net/` (region must match the account, e.g. `https://eastus.codesigning.azure.net/`)
   - **Signing account name** — the account resource name
   - **Certificate profile name** — from step 2

**3. Create an App Registration for GitHub Actions (OIDC)**

1. **Microsoft Entra ID** → **App registrations** → **New registration** (e.g. `varlock-github-signing`)
2. Note the **Application (client) ID** and **Directory (tenant) ID**
3. **Certificates & secrets** → **Federated credentials** → **Add credential** (one per ref type):
   - **Branch** — Organization: `dmno-dev`, Repository: `varlock`, Branch: `main`
   - **Tag** — Tag: `varlock@*` (required for release builds)
   - **Pull request** — optional, for `release-preview` PR builds
4. Open your **Certificate profile** in the portal → **Access control (IAM)** → **Add role assignment**
   - Role: **Artifact Signing Certificate Profile Signer**
   - Assign to the app registration from step 1

**4. Configure GitHub repository**

Store values in the **VarlockCI** 1Password vault (see `packages/encryption-binary-rust/.env.schema`) or set them directly in GitHub.

Add **secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |

Add **variables** (same settings page, Variables tab):

| Variable | Value |
|----------|-------|
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | e.g. `https://eastus.codesigning.azure.net/` |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_ARTIFACT_SIGNING_PROFILE` | Certificate profile name |

OIDC is used by default (no client secret needed). The Windows job runs `azure/login` before signing; credentials from that step are picked up automatically.

**5. Verify**

Trigger a workflow that builds native Rust binaries (e.g. a release or a PR with the `release-preview` label). The Windows job should:

1. Run **Azure login (OIDC)**
2. Run **Sign Windows binary (Azure Artifact Signing)**
3. Upload a signed `varlock-local-encrypt.exe`

Download the artifact and verify locally on Windows:

```powershell
signtool verify /pa /v path\to\varlock-local-encrypt.exe
```

**Cost:** Artifact Signing Basic is ~$10/month. Certificates are short-lived and managed automatically — no `.pfx` or USB token required.
