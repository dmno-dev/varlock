---
"varlock": patch
---

Fix: Bun auto-load doesn't resolve function-call resolvers from .env.local

When using `varlock/auto-load` as a Bun preload, Bun pre-loads `.env.local` into `process.env` before the preload module runs. This caused resolver function calls (e.g. `bitwarden("...")`) to be treated as literal strings instead of being resolved.

The `valueResolver` getter in `config-item.ts` now checks whether a `process.env` override value matches the `toString()` of a `ParsedEnvSpecFunctionCall` defined in a source file. If it matches, the static override is skipped and the file-defined resolver is used instead.
