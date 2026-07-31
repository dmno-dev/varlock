# sandbox fixture

Deliberately contains NO `.env` files: simulates an environment (e.g. a remote sandbox)
where only the `__VARLOCK_ENV` blob is provided and `varlock/auto-load` must hydrate
everything from it via `_VARLOCK_USE_INJECTED_ENV=1`.
