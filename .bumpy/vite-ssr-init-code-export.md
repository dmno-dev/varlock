---
"@varlock/vite-integration": minor
---

Add a `rootDir` option so integrations can point varlock at the project root when the framework sets vite's `root` to a source subdirectory, and export `buildVarlockSsrInitCode` for build pipelines vite does not own.
