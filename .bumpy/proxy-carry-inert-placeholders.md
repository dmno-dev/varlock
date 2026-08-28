---
varlock: minor
---

Proxy: a placeholder appearing in a request surface its rule doesn't substitute in (e.g. the body under the default header-only targets) is now carried through unsubstituted and logged as a carried-placeholder audit event, instead of blocking the request. Blocking still applies to off-path occurrences within body:<path>/query:<param> targets and to the maxOccurrences cap, which now counts only occurrences at allowed targets.
