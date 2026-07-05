---
varlock: patch
"@varlock/nextjs-integration": patch
---

Encrypted deployments now work on edge runtimes without node:crypto (e.g. Vercel Edge middleware): the edge init bundle falls back to async WebCrypto decryption and gates handler invocation until env is ready
