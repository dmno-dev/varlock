---
varlock: minor
---

Add a shape mode for tools that only inspect a schema. `new EnvGraph({ mode: "shape" })` runs only pure resolvers, skips root decorator execution and the cache, never downloads plugins, and ignores `process.env` overrides. Plugin resolvers can opt in with `pure: true`.
