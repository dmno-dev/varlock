---
varlock: patch
---

Error output fixes:
- errors thrown from a root decorator are no longer printed twice
- a failing `exec()` no longer dumps a raw stack trace to stdout (which broke `load --format json-full`); the error now includes the exit code and stderr
- an invalid static `@cache` value is reported once
- a root decorator referencing an invalid item now shows that item's errors
- `json-full` item errors no longer include warnings
- `load --format json-full` now includes a `warnings` object (same shape as `errors`)
