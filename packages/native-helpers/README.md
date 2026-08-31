# native-helpers

Publishing shells for the `@varlock/native-helper-*` npm packages: one per platform, installed automatically through `varlock`'s `optionalDependencies` so each user only downloads the binary for their own platform.

These folders intentionally contain no binaries and no source code, just npm metadata (`os`/`cpu` constraints, version, files list). The binaries come from elsewhere:

- **darwin**: built from [`packages/encryption-binary-swift`](../encryption-binary-swift/) (Secure Enclave, Touch ID)
- **linux-x64 / linux-arm64 / win32-x64**: built from [`packages/encryption-binary-rust`](../encryption-binary-rust/) (TPM2/polkit on Linux, TPM/DPAPI + Windows Hello on Windows)

CI builds, signs, and stages the binaries into `packages/varlock/native-bins/<platform>/` (local dev builds stage there too). At pack/publish time, each package's `prepack` script ([prepack.ts](./prepack.ts)) copies its binary in from that staging dir, and refuses to pack if the binary is missing.

Notes:

- `win32-x64` declares `os: ["win32", "linux"]` on purpose: WSL runs the Windows `.exe` through interop for DPAPI and Windows Hello support, so it must also install on Linux.
- Versions are kept in lockstep with `varlock` via the bumpy `fixed` group in `.bumpy/_config.json`; `varlock` pins them as exact versions. Never bump these packages independently.
- The source packages stay separate because they do not map 1:1 to npm packages (one Rust crate produces three of them), and because the shells are pure distribution metadata while the source packages are build systems.
