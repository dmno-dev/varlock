---
varlock: major
env-spec-language: minor
---

The `url` type's strict checks are now errors instead of warnings: values must be written as `scheme://...` with a well-formed host (or `allowNoHost=true`), and only `http`/`https` are allowed unless `allowedProtocols` is set (`allowedProtocols="*"` allows any). `prependHttps` now prefixes any value not starting with `scheme://`.
