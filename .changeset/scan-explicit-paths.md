---
"varlock": minor-isolated
---

`varlock scan` now accepts optional positional path/glob arguments to scan specific files, directories, or glob patterns instead of the whole repo. This is useful for scanning build output folders (e.g. `dist`, `.next`) to ensure no secrets leaked into what will be published.

```sh
varlock scan ./dist             # Scan a specific build output directory
varlock scan ./dist ./public    # Scan multiple directories
varlock scan './dist/**/*.js'   # Scan files matching a glob pattern
```

When explicit paths are provided, git-aware filtering (`--staged`, `--include-ignored`) is bypassed, and build-output directories that are normally skipped (such as `dist`, `.next`, `build`) are scanned without restriction.
