---
"@varlock/nextjs-integration": patch
---

Fix env file watchers keeping short-lived processes (such as Next's telemetry helper after `next dev` stops) running forever
