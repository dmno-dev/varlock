---
varlock: minor
---

Proxy: secrets are now substituted into request headers only by default, and a placeholder may appear at most once per request. Widen with @proxy(substituteIn=[...]) using targets like header:authorization, query:api_key, or body:client_secret (body always needs a path), and raise the cap with maxOccurrences. This prevents an injected secret from being swapped into a request body, query, or unintended header where it could be exfiltrated.
