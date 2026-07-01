---
varlock: minor
---

Generate types for Python, Rust, Go, and PHP with new per-language decorators (`@generatePythonTypes`, `@generateRustTypes`, `@generateGoTypes`, `@generatePhpTypes`). The TypeScript generator moves to `@generateTsTypes` and gains options to control `process.env`/`import.meta.env` augmentation and a monorepo-friendly `env=module` mode. `@generateTypes(lang=ts)` still works as a deprecated alias.
