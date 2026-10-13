---
varlock: minor
env-spec-language: minor
---

The `url` type now warns on values that only parse because `new URL()` is permissive: anything not written as `scheme://...` (like an SSH key fingerprint `SHA256:...` or `user:pass`), whitespace or control characters, a missing host, and malformed `http`/`https` hosts the parser would otherwise rewrite (`https:///example.com`, `http://0x7f.1`, `https://a..b`). It also warns on protocols other than `http`/`https` when `allowedProtocols` is not set. These become errors in the next major version. New options: `allowedProtocols="*"` allows any protocol, and `allowNoHost=true` allows host-less URLs like `sqlite:///app.db`.
