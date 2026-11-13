---
varlock: minor
env-spec-language: patch
---

Add built-in `timeZone` data type that validates IANA time zone names. Rename the `simple-object` data type to `simpleObject` so all built-in type names are camelCase (`simple-object` still works but logs a deprecation warning).
