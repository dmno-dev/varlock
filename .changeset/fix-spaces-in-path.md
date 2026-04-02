---
"varlock": patch
---

Fix execSyncVarlock breaking when project path contains spaces

Use `execFileSync` instead of `execSync` for the fallback varlock path resolution to avoid shell interpretation of spaces in directory paths.
