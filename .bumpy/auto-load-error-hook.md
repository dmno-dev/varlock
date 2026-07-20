---
varlock: minor
---

Report load failures to error trackers. `varlock/auto-load` can now throw the load error (instead of exiting silently) so a reporter like Sentry can capture it. Opt in with a `globalThis._varlockOnLoadError` hook (called with the error and the values that did resolve), or set `_VARLOCK_THROW_ON_LOAD_ERROR=1` when a reporter is already initialized. Default behavior is unchanged.
