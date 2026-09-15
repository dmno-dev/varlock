---
varlock: major
env-spec-language: minor
---

A pattern must be written as a `regex("pattern", "flags")` call. A string is no longer read as a regex anywhere: on `matches` it is an error that shows the `regex()` call to write, in `remap()` a match value like `/usr/lib/` is compared exactly like any other string, and `@auditExtraPatterns()` accepts `regex()` calls only. A pattern taken from another variable (`matches=$PATTERN`) is an error too, since there is no dynamic form. The previous release deprecated every one of these with a warning that shows the `regex()` call to write.
