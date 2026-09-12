# Changelog



## 0.1.2
<sub>2026-09-12</sub>

- [#1076](https://github.com/dmno-dev/varlock/pull/1076)  *(patch)*
  Fix `vite dev` failing with `encrypted env blob present but _VARLOCK_ENV_KEY is not set` when `@encryptInjectedEnv` is enabled and the SSR dev runtime is a separate worker (Nitro v3 / TanStack Start, vitest). The temporary dev key is now minted in an early dev-server config hook, before other plugins spawn their runtimes, so they inherit it; Cloudflare dev targets fall back to plaintext since workerd cannot read host env vars. The Nuxt module mints the same dev key before writing its Nitro init template, so `nuxt dev` with `@encryptInjectedEnv` and `resolved-env` gets an encrypted blob instead of plaintext. `vite preview` never mints a key. Builds never create or use the dev key and still require `_VARLOCK_ENV_KEY`. Also warns when `_VARLOCK_ENV_KEY` or `__VARLOCK_ENV` is set via vite `define`, which does not work.

## 0.1.1
<sub>2026-09-01</sub>

- *(patch)* Version bump from `@varlock/vite-integration` v1.5.1

## 0.1.0
<sub>2026-08-25</sub>

- [#985](https://github.com/dmno-dev/varlock/pull/985)  *(minor)*
  Add the Nuxt integration (supports Nuxt 3 and 4): build-time inlining and validation via the shared vite plugin, log redaction and response leak prevention in the nitro server, dev server restarts on env file changes (config-time values included), automatic registration of generated env types, and an auto-injected endpoint serving public dynamic values to the browser.
- [#1021](https://github.com/dmno-dev/varlock/pull/1021)  *(patch)* - Build with tsdown instead of tsup; published files now use explicit .mjs/.cjs extensions.
