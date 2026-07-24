---
varlock: patch
---

proxy: minted MITM certs now include subject/authority key identifiers so strict TLS verifiers (python 3.13+ urllib/httpx defaults) accept them; Proxy-Authorization from clients is stripped instead of forwarded upstream
