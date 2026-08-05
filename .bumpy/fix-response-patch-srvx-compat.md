---
varlock: patch
---

fix `@preventLeak` breaking srvx-based servers (TanStack Start, Nitro) by patching the global Response with a proxy instead of a subclass
