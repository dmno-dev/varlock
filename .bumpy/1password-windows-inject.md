---
"@varlock/1password-plugin": patch
---

CLI batch reads now use op inject instead of op run -- env -0, fixing failures on Windows where no unix env binary exists
