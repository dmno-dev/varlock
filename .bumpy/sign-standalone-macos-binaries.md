---
varlock: patch
---

The standalone macOS `varlock` binaries are now Developer ID signed and notarized, with the hardened runtime enabled and no entitlement exceptions granted. Without the hardened runtime, any process running as your user could attach to varlock and read resolved secrets out of its memory.
