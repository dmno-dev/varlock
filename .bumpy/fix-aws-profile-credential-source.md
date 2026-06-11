---
"@varlock/aws-secrets-plugin": patch
---

fix: resolve named AWS profiles via the full node provider chain so credential_source entries (e.g. EcsContainer) work
