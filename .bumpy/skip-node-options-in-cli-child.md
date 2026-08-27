---
varlock: patch
---

auto-load and framework integrations no longer pass NODE_OPTIONS to the varlock CLI subprocess, so preloaded modules (e.g. NODE_OPTIONS="-r next-logger") can no longer corrupt its output and crash env loading
