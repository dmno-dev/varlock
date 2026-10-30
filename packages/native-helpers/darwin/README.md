# @varlock/native-helper-darwin

macOS native helper for [varlock](https://varlock.dev)'s [local encryption](https://varlock.dev/guides/local-encryption/) (Secure Enclave, Touch ID).

This package is installed automatically as an optional dependency of [`varlock`](https://www.npmjs.com/package/varlock). Do not install it directly.

The binary (`VarlockEnclave.app`) is Developer ID signed and notarized. Checksums are published in `SHA256SUMS.txt` on each [varlock GitHub release](https://github.com/dmno-dev/varlock/releases) that ships this helper (its version can be older than varlock's, since helpers are only re-released when the binary changes).
