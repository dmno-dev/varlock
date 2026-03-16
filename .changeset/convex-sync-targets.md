---
"varlock": patch
---

Add `syncTargets` field to `SerializedEnvGraph` config items, populated from `@syncTarget()` function-call decorators. Also guard against missing global `Buffer` in runtimes like Convex's serverless environment.
