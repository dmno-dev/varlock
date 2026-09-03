---
varlock: patch
env-spec-language: patch
---

Data type fixes. `@type=enum` now matches numeric and boolean members against string values from `process.env` and `overrideValues`, so `LEVEL=2` or `FLAG=true` from CI satisfies `enum(1, 2, 3)` / `enum(true, false)`. `@type=url` matches `allowedDomains` in full against the URL host instead of as a substring, which previously let `example.com` pass an allowlist of `myexample.com`; write two or more hosts as an array (`allowedDomains=[a.com, b.com]`), since a comma inside a single string now errors and names the array to use. `@type=url(noTrailingSlash=true)` allows a root `/` as the docs already described. `@type=ip(version=6)` accepts IPv4-mapped addresses like `::ffff:192.168.1.1`. `@type=md5` accepts uppercase hex and normalizes it to lowercase. `@type=port` rejects non-integers such as `80.5`.
