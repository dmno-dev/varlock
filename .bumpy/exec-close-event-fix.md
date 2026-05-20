---
varlock: patch
---

fix: resolve exec Promise on close event (not exit) to ensure piped stdout/stderr is fully flushed before gracefulExit - fixes child output lost on Windows PowerShell
