---
varlock: minor
---

Credential proxy: request signing via transform= on @proxy rules. Generic HMAC (hmac-sha256/hmac-sha512) signs the final outbound request with a signing secret the agent never holds; aws-sigv4 re-signs AWS SDK requests made with placeholder credentials, deriving region/service from the request with optional allowlists.
