---
varlock: patch
"@varlock/nextjs-integration": patch
---

Accept `VARLOCK_ENV_KEY` (and the other `_VARLOCK_*` config vars without the leading underscore) for platforms like AWS Lambda that reject env var names starting with `_`
