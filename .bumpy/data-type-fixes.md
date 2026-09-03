---
varlock: patch
env-spec-language: patch
---

Data type fixes. `@type=enum` now matches numeric and boolean members against string values from `process.env` and `overrideValues`, so `LEVEL=2` or `FLAG=true` from CI satisfies `enum(1, 2, 3)` / `enum(true, false)`. `@type=url` treats `allowedDomains="a.com,b.com"` as a host list instead of a substring match, and `noTrailingSlash=true` now allows a root `/` as the docs already described. `@type=ip(version=6)` accepts IPv4-mapped addresses like `::ffff:192.168.1.1`. `@type=md5` accepts uppercase hex and normalizes it to lowercase. `@type=port` rejects non-integers such as `80.5`.
