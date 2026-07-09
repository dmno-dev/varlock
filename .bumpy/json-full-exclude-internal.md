---
varlock: patch
---

Fix: `varlock load --format json-full` no longer includes `@internal` items by default (pass `--include-internal` to opt in for local debugging). Framework integrations shell out to this exact command to get their injected config, so this closes a leak where an `@internal` secret-zero credential could reach client/SSR runtime code.
