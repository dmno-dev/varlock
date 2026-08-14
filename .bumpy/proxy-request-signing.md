---
varlock: minor
---

Credential proxy: request signing via transform= on @proxy rules. The proxy computes an HMAC signature (hmac-sha256/hmac-sha512) over the final outbound request with a signing secret the agent never holds, writing it into configurable headers.
