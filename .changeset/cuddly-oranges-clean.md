---
"varlock": patch
---

fix native binary resolution for bundled npm/WSL layouts by locating native-bins from the detected varlock package root, and improve WSL biometric decrypt reliability by prestarting the Windows daemon and polling readiness before first decrypt
