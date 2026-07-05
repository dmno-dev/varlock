---
varlock: patch
---

Runtime fixes: env state is now shared across bundled copies of `varlock/env` (fixes stale values after env reloads when a bundler duplicates the module), and `node:crypto` is loaded lazily — with encrypted env blobs decrypting via WebCrypto on edge runtimes that lack it entirely (e.g. Vercel Edge)
