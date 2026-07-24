---
varlock: patch
---

proxy client compatibility fixes: minted MITM certs now include subject/authority key identifiers so strict TLS verifiers (python 3.13+ urllib/httpx defaults) accept them; the injected env now sets NODE_USE_ENV_PROXY=1 so Node's built-in fetch (node 24+) routes through the proxy instead of silently bypassing it, and DENO_CERT so Deno trusts the proxy CA; Proxy-Authorization from clients is stripped instead of forwarded upstream
