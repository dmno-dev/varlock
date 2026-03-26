---
"@varlock/aws-secrets-plugin": patch
---

Fall back to default AWS credential chain when @initAws profile is unavailable (e.g. no ~/.aws/config in containers/k8s). Previously this would hard-fail even when valid credentials were available via env vars or IRSA.
