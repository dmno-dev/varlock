---
"varlock": patch
---

Fix varlock binary detection on Windows with pnpm - now also checks for varlock.cmd in addition to varlock.exe, since pnpm does not create .exe shims
