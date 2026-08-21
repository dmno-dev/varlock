---
varlock: patch
---

Injected env blob reuse now detects .env source file edits: auto-load and varlock run re-resolve instead of serving stale values when a source file changed since the blob was created
