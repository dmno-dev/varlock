---
varlock: minor
---

`varlock load --format json-full` now reports errors as structured objects with a stable `code` (was free-text strings), so tools can branch on the code instead of matching messages. Warnings are reported too, under a separate `warnings` key, so `errors` still means the load failed. A missing `.env.schema` is still fine, but finding no env files at all, or files that define no items, is now reported as an error in the output and exits non-zero for every format.
