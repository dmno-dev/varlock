---
varlock: major
"@varlock/nextjs-integration": patch
---

`varlock/auto-load` and the framework integrations now fail when no config items are loaded (no .env files found, or none define items), matching `varlock load` and `varlock run`. `load --format json-full` reports it in `errors.root` and exits non-zero. Set `_VARLOCK_ALLOW_EMPTY_CONFIG=1` to keep running with an empty config.
