---
varlock: patch
---

Reusing an injected env blob (auto-load under `varlock run`) now also re-resolves when an env file it would load, like `.env.local`, was created after the blob was made
