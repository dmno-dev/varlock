---
varlock: patch
---

Redact sensitive values from Error objects passed to console methods, and fix console redaction of plain objects that could not survive a JSON round-trip (nested errors, circular references, bigints, dates)
