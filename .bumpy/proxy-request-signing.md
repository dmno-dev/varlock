---
varlock: minor
---

Credential proxy: request signing via transform= on @proxy rules. Generic HMAC (hmac-sha256/hmac-sha512) signs the final outbound request with a signing secret the agent never holds, and http-basic writes Basic auth headers the proxy composes from the real credentials (base64 encoding otherwise hides placeholders from substitution), with either side of the user:password pair able to hold the secret. Credential options always reference config items, so values stay out of rule data. Transform options reference credential items with $ITEM syntax; the references are captured without resolving, so secret values never enter rule data. Plugins can register additional signing schemes (option specs drive validation and placeholder management; the signer runs in the proxy per matching request).
