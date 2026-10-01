---
varlock: patch
---

Fix `varlock proxy` shutdown hanging when a client had read a blocked response over a MITM tunnel, or still held an idle CONNECT tunnel open
