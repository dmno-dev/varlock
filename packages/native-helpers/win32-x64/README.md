# @varlock/native-helper-win32-x64

Windows x64 native helper for [varlock](https://varlock.dev)'s [local encryption](https://varlock.dev/guides/local-encryption/) (TPM sealing / DPAPI, Windows Hello).

This package is installed automatically as an optional dependency of [`varlock`](https://www.npmjs.com/package/varlock). Do not install it directly.

It declares `os: ["win32", "linux"]` on purpose: under WSL, varlock runs the Windows `varlock-local-encrypt.exe` through WSL interop to get DPAPI and Windows Hello support, so the helper must also be installed on Linux.

The binary is Authenticode-signed. Checksums for every release are published in `SHA256SUMS.txt` on the matching [GitHub release](https://github.com/dmno-dev/varlock/releases).
