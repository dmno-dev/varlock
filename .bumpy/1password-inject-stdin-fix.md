---
"@varlock/1password-plugin": patch
---

Fix 1Password CLI batch reads failing with "expected data on stdin but none found". The op inject template is now passed as a file rather than on stdin, which op only accepts from a true pipe.
