---
varlock: patch
env-spec-language: patch
---

`url(allowedDomains=...)` now rejects values whose host other URL parsers could read differently (backslashes, whitespace, percent-encoded hosts, IPv4 shorthand, missing `scheme://host`), which could let a value pass the allowlist while the app connects elsewhere. `url(prependHttps=true)` now prefixes `host:port` values like `localhost:3000`.
