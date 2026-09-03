---
varlock: patch
env-spec-language: patch
---

Data type fixes. `@type=enum` now matches numeric and boolean members against string values from `process.env` and `overrideValues`, so `LEVEL=2` or `FLAG=true` from CI satisfies `enum(1, 2, 3)` / `enum(true, false)`. `@type=url` matches `allowedDomains` in full against the URL host instead of as a substring, accepting either an array (`allowedDomains=[a.com, b.com]`) or a comma-separated string, and `noTrailingSlash=true` now allows a root `/` as the docs already described. `@type=ip(version=6)` accepts IPv4-mapped addresses like `::ffff:192.168.1.1`. `@type=md5` accepts uppercase hex and normalizes it to lowercase. `@type=port` rejects non-integers such as `80.5`.
