---
"@varlock/1password-plugin": patch
"@varlock/google-secret-manager-plugin": patch
---

fix: use `fileURLToPath` instead of `.pathname` to derive `__dirname` in plugin ESM banner, preventing doubled drive letters (`C:\C:\...`) on Windows
