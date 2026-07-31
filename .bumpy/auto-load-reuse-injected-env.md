---
varlock: minor
---

varlock/auto-load now reuses the env blob injected by a parent varlock run instead of re-resolving via the CLI, when it was resolved in the same directory. Set _VARLOCK_USE_INJECTED_ENV=1 to always trust an injected blob (e.g. handing env into a sandbox with no .env files), or 0 to always re-resolve.
