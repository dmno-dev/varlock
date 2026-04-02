---
"varlock": patch
"@varlock/vite-integration": patch
---

Fix Vitest workspace projects in monorepos: when running Vitest from the monorepo root using the `projects` config, varlock now correctly resolves `.env.schema` and `.env` files from each child package's directory instead of only looking in the monorepo root.
