---
varlock: minor
"@varlock/nextjs-integration": patch
---

`varlock/auto-load` and the framework integrations now warn when no config items are loaded (no .env files found, or none define items) instead of silently continuing with an empty config. This becomes an error in the next major. Set `_VARLOCK_ALLOW_EMPTY_CONFIG=1` to allow an empty config, which also lets `varlock load` and `varlock run` succeed with an empty config.
