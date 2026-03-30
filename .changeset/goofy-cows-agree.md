---
"@varlock/1password-plugin": patch
---

- fix: `checkOpCliAuth()` now always returns a completion callback (a no-op after the mutex is already settled) so follow-up `op` CLI paths still signal success/failure correctly; previously only the first call returned the deferred `resolve` function.
