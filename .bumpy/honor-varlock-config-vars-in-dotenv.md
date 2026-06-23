---
varlock: minor
---

Honor `_VARLOCK_*` config vars set as static values in `.env` / `.env.local`. Setting `_VARLOCK_ENV_KEY`, `_VARLOCK_CACHE_KEY`, or `_VARLOCK_REDACT_STDOUT` in a (gitignored) `.env.local` now configures varlock — handy for local development. A real environment variable still takes precedence. These keys configure varlock itself, so they never appear as app config (excluded from the resolved env, `varlock load` output, and the injected blob). Only `.env`/`.env.local` are honored — a `_VARLOCK_*` key in another file warns it has no effect, an unrecognized key warns (likely a typo), and a non-static value is an error.
