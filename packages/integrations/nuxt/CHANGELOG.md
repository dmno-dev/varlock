# Changelog

## 0.1.0
<sub>2026-08-25</sub>

- [#985](https://github.com/dmno-dev/varlock/pull/985)  *(minor)*
  Add the Nuxt integration (supports Nuxt 3 and 4): build-time inlining and validation via the shared vite plugin, log redaction and response leak prevention in the nitro server, dev server restarts on env file changes (config-time values included), automatic registration of generated env types, and an auto-injected endpoint serving public dynamic values to the browser.
- [#1021](https://github.com/dmno-dev/varlock/pull/1021)  *(patch)* - Build with tsdown instead of tsup; published files now use explicit .mjs/.cjs extensions.
