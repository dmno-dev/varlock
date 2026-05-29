---
"varlock": patch
---

Fix `varlock/auto-load` in serverless bundles where `node_modules/.bin/varlock` is omitted by falling back to the package-local CLI entry.
