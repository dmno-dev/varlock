---
varlock: minor
---

Proxy: secrets are now substituted into request headers only by default (excluding common forward/log headers like cookie and x-forwarded-*), and a placeholder may appear at most once per request. Widen with @proxy(substituteIn=[...]) using targets like header:authorization, path, query:api_key, or body:client_secret (body always needs a path; use body:* for bodies that can't be parsed into one), and raise the cap with maxOccurrences. This prevents an injected secret from being swapped into a request body, query, or unintended header where it could be exfiltrated.
