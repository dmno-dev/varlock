---
"@varlock/google-secret-manager-plugin": patch
"@varlock/aws-secrets-plugin": patch
"@varlock/aws-sigv4-plugin": patch
"@varlock/infisical-plugin": patch
---

Build the plugin as a single file. The split chunks re-ran the plugin outside of its context, so `gsm()` failed every call with "No active plugin context" (aws-secrets, aws-sigv4 and infisical could hit the same error on some code paths)
