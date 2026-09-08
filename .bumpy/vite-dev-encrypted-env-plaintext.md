---
"@varlock/vite-integration": patch
---

Fix `vite dev` failing with `encrypted env blob present but _VARLOCK_ENV_KEY is not set` when `@encryptInjectedEnv` is enabled and the SSR dev runtime is a separate worker (Nitro v3 / TanStack Start, vitest). The temporary dev key is now minted in an early dev-server config hook, before other plugins spawn their runtimes, so they inherit it; Cloudflare dev targets fall back to plaintext since workerd cannot read host env vars. Builds never create or use the dev key and still require `_VARLOCK_ENV_KEY`. Also warns when `_VARLOCK_ENV_KEY` or `__VARLOCK_ENV` is set via vite `define`, which does not work.
