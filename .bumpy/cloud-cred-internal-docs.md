---
"@varlock/aws-secrets-plugin": patch
"@varlock/azure-key-vault-plugin": patch
"@varlock/google-secret-manager-plugin": patch
---

Docs: recommend marking cloud-provider credentials @internal when varlock is the only consumer (use @internal=false to opt out if your app reads them directly).
