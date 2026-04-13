---
"varlock": patch
---

Fix `declare module 'varlock/env'` type augmentation breaking in monorepo setups where multiple packages each have their own `.env.schema` and generated `env.d.ts`. Use unique type aliases per schema so that `CoercedEnvSchema` and `EnvSchemaAsStrings` names don't collide when multiple `env.d.ts` files are in the same TypeScript compilation.
