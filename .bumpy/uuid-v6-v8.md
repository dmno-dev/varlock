---
varlock: minor
env-spec-language: patch
---

`uuid` type now accepts UUID versions 6-8 (RFC 9562, including UUIDv7) and the MAX UUID, and takes an optional `version` option (e.g. `@type=uuid(version=7)`) to require a specific version.
