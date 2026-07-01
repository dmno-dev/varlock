---
varlock: minor
---

Add per-language code-generation decorators: `@generateTsTypes`, `@generatePythonTypes`, `@generateRustTypes`, `@generateGoTypes`, and `@generatePhpTypes`. `@generateTsTypes` adds options to control global augmentation (`processEnv`/`importMetaEnv`) and an `env=module` mode that emits a package-local importable `ENV` for monorepos. `@generateTypes(lang=...)` is kept as a deprecated TypeScript-only alias, and plugins can now contribute their own generators.
