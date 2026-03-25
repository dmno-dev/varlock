---
"varlock": minor
---

Add `strict=true` argument to `@generateTypes` decorator.

When set, the generated `env.d.ts` adds a `[key: string]: unknown` index signature to both `ProcessEnv` and `ImportMetaEnv`, making TypeScript flag accesses to undeclared env variables as `unknown` rather than implicitly allowing them.
