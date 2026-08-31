---
"@varlock/nextjs-integration": patch
"varlock": minor
---

Fix "exports is not defined in ES module scope" when using varlockNextConfigPlugin in a next.config.ts file. varlock now ships CJS builds of its runtime entry points (varlock/env, varlock/patch-console, varlock/patch-server-response, varlock/encrypt-env, varlock/exec-sync-varlock) via the `require` condition, so requiring them from CommonJS works through Next's TypeScript config loader and on Node versions without require(esm) support (below 22.12).
