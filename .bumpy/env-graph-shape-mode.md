---
varlock: minor
---

Add a shape mode for tools that only inspect a schema. `new EnvGraph({ mode: "shape" })` runs only pure resolvers, skips root decorator execution and the cache, never downloads plugins, ignores the shell environment, keeps generated code inside the project, and refuses schema files that are not regular files. Plugin resolvers can opt in with `pure: true`.
