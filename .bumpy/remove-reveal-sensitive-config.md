---
varlock: major
"@varlock/cloudflare-integration": major
---

Remove `revealSensitiveConfig()`. To print a sensitive value on purpose, exempt it with `@sensitive={redact=false}`, or turn off redaction with `@redact=false` or `--no-redact-stdout`.
