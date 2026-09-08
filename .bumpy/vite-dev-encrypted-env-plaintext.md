---
"@varlock/vite-integration": patch
---

Fix `vite dev` failing with `encrypted env blob present but _VARLOCK_ENV_KEY is not set` when `@encryptInjectedEnv` is enabled and the SSR dev runtime is a separate worker (Nitro v3 / TanStack Start, vitest, workerd). Dev servers now inject the env as plaintext unless `_VARLOCK_ENV_KEY` is already set in the environment; builds still require the key. Also warns when `_VARLOCK_ENV_KEY` or `__VARLOCK_ENV` is set via vite `define`, which does not work.
