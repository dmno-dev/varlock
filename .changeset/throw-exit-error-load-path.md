---
"varlock": patch
---

Fix: invalid load path errors now throw a `CliExitError` instead of logging and calling `gracefulExit`, for consistent error handling across the CLI.
