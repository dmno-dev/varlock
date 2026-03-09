---
"varlock": minor
---

Environment-independent type generation

- Type generation now runs before env value resolution, producing deterministic TypeScript types regardless of which environment is active
- Added `isEnvSpecific` tracking on data sources to identify environment-dependent files (`.env.production`, conditional `@disable`, conditional `@import`)
- Items defined only in env-specific files are excluded from generated types
- Added `auto=false` parameter to `@generateTypes` decorator to disable automatic type generation during `varlock load` and `varlock run`
- Added `varlock typegen` command for manual type generation
