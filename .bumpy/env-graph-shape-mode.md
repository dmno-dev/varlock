---
varlock: minor
---

Add a shape mode for tools that only inspect a schema. `new EnvGraph({ mode: "shape" })` (or `loadEnvGraph({ mode: "shape" })`) runs only pure resolvers, skips root decorator execution and the cache, never downloads plugins, ignores the shell environment, keeps generated code inside the project, and skips files that are not regular files. `@setValuesBulk` is applied when its data is written in the schema, and a file that is only loaded because its condition could not be evaluated never loads a plugin. Plugin resolvers can opt in with `pure: true`. A `@required`/`@sensitive` or `forEnv()` that depends on a skipped value is reported as unknown (`isRequiredUnknownInShapeLoad`, `isSensitiveUnknownInShapeLoad`) and treated as optional and sensitive.
