---
varlock: minor
---

Plugin cache: `getOrSet` now accepts a TTL callback, so a plugin can set the cache lifetime from the value it just fetched (an STS session, an OAuth token, a lease). Also fixes plugin caching to respect the cache mode set via the `@cache` root decorator.
