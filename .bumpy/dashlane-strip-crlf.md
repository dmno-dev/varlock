---
'@varlock/dashlane-plugin': patch
---

Strip the Windows line ending (`\r\n`) from `dcli read` output, so resolved values no longer end in a stray carriage return on Windows
