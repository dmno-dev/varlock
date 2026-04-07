---
"varlock": patch
---

Add version mismatch detection between standalone binary and local node_modules install

When running the standalone binary (installed via homebrew/curl), varlock now checks if a different version is installed in the project's node_modules. If a version mismatch is detected, a warning is displayed suggesting users update the binary or use the locally installed version instead. This helps prevent confusing errors caused by running mismatched versions.
