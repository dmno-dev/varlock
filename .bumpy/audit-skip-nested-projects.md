---
varlock: patch
---

Improved `audit` and `init` env var scanning in monorepos:

- Scanning no longer descends into child packages — any subdirectory with its own `package.json` or `.env.schema` is treated as a separate package and skipped. This fixes spurious results and makes scanning much faster.
- Pure execution-environment plumbing (`PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `npm_*`, etc.) is no longer reported as "missing in schema" by `audit`, nor added to inferred schemas by `init`. App-meaningful vars like `NODE_ENV` and CI variables are still reported.
