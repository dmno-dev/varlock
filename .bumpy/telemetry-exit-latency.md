---
varlock: patch
---

Telemetry no longer adds latency to CLI commands. Events still in flight when a command finishes are handed to a detached background process instead of being awaited, so `varlock load` and `varlock/auto-load` take the same time with telemetry on or off.
