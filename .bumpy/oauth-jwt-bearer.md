---
varlock: minor
---

oauth() now supports the jwt_bearer grant (RFC 7523): sign an RS256 assertion from a Google-style service account key (or a raw private key + issuer) and exchange it for a short-lived access token, so apps and agents never hold the permanent key
