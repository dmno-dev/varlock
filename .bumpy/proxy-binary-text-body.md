---
varlock: patch
---

Proxy: response scrubbing and body substitution no longer corrupt non-UTF-8 bodies (e.g. Go checksum database tiles served as text/plain), HEAD responses keep their `content-length`, and 206 partial responses are no longer rewritten
