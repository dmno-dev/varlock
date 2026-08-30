---
varlock: minor
---

Proxy: a placeholder appearing in a request surface its rule doesn't substitute in (e.g. the body under the default header-only targets) is now skipped (forwarded unsubstituted) and logged as a skipped-placeholder audit event, instead of blocking the request. Blocking still applies to occurrences off the named path/param within a body:<path> or query:<param> target.

The `maxOccurrences` option has been removed. Each `substituteIn` target is now worth one substitution per request, so listing a target is what grants it an occurrence: an API that carries the secret in two places just names both (`substituteIn=["header:authorization", "body:signature"]`) instead of raising a count. A repeat at the same target still blocks. Setting `maxOccurrences` is now a schema error that points at the replacement.
