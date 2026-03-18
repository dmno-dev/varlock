---
"@varlock/bitwarden-plugin": patch
"@varlock/infisical-plugin": patch
"varlock": patch
---

fix: defer plugin auth errors until resolver is actually used, and prefix resolution errors with resolver function name for clearer error messages
