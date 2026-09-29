---
varlock: minor
"@varlock/nextjs-integration": patch
---

`varlock/auto-load` and the framework integrations now warn when no .env schema is found instead of silently loading an empty config (this becomes an error in the next major). Set `_VARLOCK_ALLOW_NO_SCHEMA=1` to run without a schema, which also lets `varlock load` and `varlock run` succeed with an empty config.
