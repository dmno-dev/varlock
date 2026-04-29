# @varlock/encryption-binary-rust

Cross-platform local encryption binary for Varlock (Windows and Linux).

Provides DPAPI key protection on Windows (with optional Windows Hello biometric), and TPM2 key protection on Linux, with a file-based plaintext fallback on both.

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
- **UPX** (optional, for binary compression):
  ```sh
  # Ubuntu/Debian
  sudo apt-get install upx-ucl
  # macOS
  brew install upx
  # Windows
  choco install upx
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

The build script automatically applies UPX compression (except on macOS). Pass `--no-upx` to skip.

## Architecture

- `src/main.rs` — CLI interface (generate-key, encrypt, decrypt, status, daemon)
- `src/crypto.rs` — ECIES encryption using pure Rust crates (no OpenSSL)
- `src/key_store/` — Platform-specific key protection:
  - `windows.rs` — DPAPI + Windows Hello
  - `linux.rs` — TPM2 via tpm2-tools
- `src/daemon.rs` — Long-lived IPC daemon for biometric session caching
- `src/ipc.rs` — IPC server (Unix socket on Linux, named pipe on Windows)
- `src/daemon_client.rs` — Named pipe client for `--via-daemon` mode (WSL2 support)

## WSL2 Support

When running from WSL2, the TypeScript side calls this Windows `.exe` directly (WSL2 can execute Windows binaries via binfmt_misc).

- `decrypt --via-daemon` routes requests through a Windows named-pipe daemon for biometric session caching.
- The WSL caller prestarts the daemon from native PowerShell and then polls readiness via `ping-daemon` before the first decrypt. This avoids first-invocation startup timeouts.
- `start-daemon` remains available for manual troubleshooting from native Windows terminals.

## CI

Binaries are built in CI via `.github/workflows/build-native-rust.yaml` on native runners for each platform. Linux targets use musl for fully static binaries that work on any Linux distribution.
