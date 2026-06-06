---
"varlock": minor
---

- Add caching system: `cache()` resolver, plugin cache API, encrypted JSON store (file mode `0600`), `varlock cache` CLI with TTY-aware browser and `--yes` confirm for `clear`.
- Add random value generators backed by `node:crypto`: `randomNum()` (integer by default, float when `precision` is set), `randomUuid()`, `randomHex()` (string-length by default, `bytes=true` for byte-length), `randomString()` (uses rejection sampling for unbiased output across any charset).
- Add `duration` data type: accepts flexible string/number input (`"1h"`, `"30m"`, `"500ms"`, `2000`, `"2days"`) and coerces to a number in a configurable output unit (`ms` default; `seconds`, `minutes`, `hours`, `days`, `weeks`). Same parser is used by `cache(..., ttl=...)` and the plugin `cacheTtl` option.
- Plugin authors can opt-in to caching via `cacheTtl` on init decorators (1password, aws-secrets, bitwarden, google-secret-manager).
