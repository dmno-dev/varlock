---
varlock: patch
env-spec-language: patch
---

`url(allowedDomains=...)` now rejects values whose host other URL parsers could read differently (backslashes, whitespace, percent-encoded or non-ASCII hosts, IPv4 shorthand, missing `scheme://host`), which could let a value pass the allowlist while the app connects elsewhere. Write internationalized hosts in punycode. `url(prependHttps=true)` now prefixes `host:port` values like `localhost:3000`.
