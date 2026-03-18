---
"@varlock/google-secret-manager-plugin": minor
---

fix: replace gRPC-based `@google-cloud/secret-manager` client with REST API + `google-auth-library` to fix ADC (Application Default Credentials) auth failures in Bun
