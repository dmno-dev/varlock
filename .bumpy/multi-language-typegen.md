---
varlock: minor
env-spec-language: patch
---

Generate code for Python, Rust, Go, and PHP with new per-language decorators (`@generatePythonEnv`, `@generateRustEnv`, `@generateGoEnv`, `@generatePhpEnv`). Each emits a self-contained, idiomatic module — typed coerced values, a loader that parses the injected env, and a `SENSITIVE_KEYS` constant — so it's usable out of the box. The TypeScript generator moves to `@generateTsTypes` and gains options to control `process.env`/`import.meta.env` augmentation and a monorepo-friendly `exposeEnv=local` mode. `@generateTypes(lang=ts)` still works as a deprecated alias. The `varlock typegen` command is renamed to `varlock codegen` (with `typegen` kept as a deprecated alias). Note: `@disableProcessEnvInjection` now requires a static `true`/`false` value — env-dependent values like `forEnv(prod)` are a schema error, since generated code must not differ per environment.
