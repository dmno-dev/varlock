---
varlock: minor
---

varlock/auto-load and varlock run now reuse an injected __VARLOCK_ENV blob instead of re-resolving, when it was resolved in the same directory. Set _VARLOCK_USE_INJECTED_ENV=1 to always trust an injected blob (e.g. handing env into a sandbox with no .env files), or 0 to always re-resolve.
