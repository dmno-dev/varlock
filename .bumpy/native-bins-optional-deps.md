---
varlock: minor
"@varlock/native-helper-darwin": minor
"@varlock/native-helper-linux-x64": minor
"@varlock/native-helper-linux-arm64": minor
"@varlock/native-helper-win32-x64": minor
---

Native local-encryption helper binaries now ship as per-platform optional dependencies (@varlock/native-helper-*), so npm installs only download the binaries for your own platform (on Linux this includes the Windows helper, which WSL needs)
