---
varlock: minor
---

Generate code for Python, Rust, Go, and PHP with new per-language decorators (`@generatePythonTypes`, `@generateRustTypes`, `@generateGoTypes`, `@generatePhpTypes`). Each emits a self-contained, idiomatic module — typed coerced values, a loader that parses the injected env, and a `SENSITIVE_KEYS` constant — so it's usable out of the box. The TypeScript generator moves to `@generateTsTypes` and gains options to control `process.env`/`import.meta.env` augmentation and a monorepo-friendly `env=module` mode. `@generateTypes(lang=ts)` still works as a deprecated alias.
