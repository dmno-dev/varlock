---
"varlock": minor
---

- Add caching system: `cache()` resolver, plugin cache API, encrypted JSON store (file mode `0600`), `varlock cache` CLI with TTY-aware browser and `--yes` confirm for `clear`.
- Cache TTLs use the shared duration format; `"forever"` caches until manually cleared (the default for `cache()`), setting a plugin's `cacheTtl` to `false` (or an empty string) disables caching, and a TTL of `0` is rejected as ambiguous.
- Cached values are individually encrypted and bound to their cache key, so entries cannot be swapped or replayed within the cache file.
- `--clear-cache` always clears the persistent disk cache, including when combined with `--skip-cache`; `@cache=disk` warns when used in CI or with the file-based encryption fallback.
- Add random value generators backed by `node:crypto`: `randomNum()` (integer by default, float when `precision` is set), `randomUuid()`, `randomHex()` (string-length by default, `bytes=true` for byte-length), `randomString()` (uses rejection sampling for unbiased output across any charset).
- Add `duration` data type: accepts flexible string/number input (`"1h"`, `"30m"`, `"500ms"`, `2000`, `"2days"`) and coerces to a number in a configurable output unit (`ms` default; `seconds`, `minutes`, `hours`, `days`, `weeks`). Only plain decimal number formats are accepted, and sub-millisecond durations are rejected. Same parser is used by `cache(..., ttl=...)` and the plugin `cacheTtl` option.
- When `_VARLOCK_CACHE_KEY` is set (e.g. as a CI secret; same format as `_VARLOCK_ENV_KEY`, but a separate var since that one can be ephemeral), `auto` cache mode uses a disk cache encrypted with that key instead of falling back to memory — enabling shared caching across CI processes without the key ever touching disk. Each key gets its own cache file, named by key fingerprint.
- `@cache` can be set dynamically with functions (e.g. `@cache=forEnv(dev, "disk")`); invalid resolved values surface as schema errors.
- Plaintext is passed to the native encryption binary via stdin instead of argv so it never appears in process listings (the macOS enclave binary gained `--data-stdin` support); debug logging no longer includes encrypt/decrypt payloads.
- Plugin opt-in caching via `cacheTtl` is documented per plugin — see the plugin packages' own changelogs.
