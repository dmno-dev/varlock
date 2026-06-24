---
varlock: patch
---

Improved `audit` and `init` env var scanning in monorepos:

- Scanning no longer descends into child packages — any subdirectory with its own `package.json` or `.env.schema` is treated as a separate package and skipped. This fixes spurious results and makes scanning much faster.
- Well-known platform/runtime/CI variables (`NODE_ENV`, `CI`, `PATH`, `npm_*`, GitHub Actions context vars, etc.) are no longer reported as "missing in schema" by `audit`, nor added to inferred schemas by `init`.
