---
"varlock": patch
---

Fix binary resolution in monorepos when `cwd` differs from the package root.

When importing `varlock/auto-load` (e.g. from a `playwright.config.ts` in a monorepo sub-package), VS Code and similar tools may set `process.cwd()` to the workspace root rather than the sub-package directory. This caused `execSyncVarlock` to search for the `varlock` binary starting at the workspace root and fail to find it when it was only installed in a sub-package's `node_modules/.bin`.

Two fixes are applied:

1. `execSyncVarlock` now accepts a `callerDir` option. When provided, the binary search walks up from `callerDir` before falling back to `process.cwd()`. `auto-load.ts` passes `import.meta.dirname` so the search always starts from inside the varlock package itself, which is already in the correct sub-package's `node_modules`.

2. The walk-up logic no longer throws immediately when it finds a `node_modules/.bin` directory that does not contain varlock. It now continues walking up, allowing the search to find varlock installed at a higher or lower level of a monorepo.
