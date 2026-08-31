---
varlock: minor
---

Credential proxy: added request transforms, which let the proxy compute a request's credential itself rather than substituting a placeholder. HMAC signing and Basic auth are built in, and plugins can contribute new transformations.
