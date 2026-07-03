---
varlock: patch
---

Windows local encryption now uses TPM-sealed keys via NCrypt when available; existing DPAPI keys auto-upgrade on the next decrypt.
