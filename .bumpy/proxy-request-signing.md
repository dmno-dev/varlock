---
varlock: minor
---

Credential proxy: request signing via transform= on @proxy rules. Generic HMAC (hmac-sha256/hmac-sha512) signs the final outbound request with a signing secret the agent never holds. Plugins can register additional signing schemes (option specs drive validation and placeholder management; the signer runs in the proxy per matching request).
