---
"@varlock/aws-secrets-plugin": minor
---

Add mfaToken param to @initAws to support MFA-protected AWS profiles (mfa_serial). The MFA code is resolved lazily, and the resulting STS session credentials are cached until they expire.
