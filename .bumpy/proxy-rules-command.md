---
varlock: patch
---

Add `varlock proxy rules` to summarize the effective `@proxy` configuration.

Prints the routing rules (host / path / method, block / approval) and each
secret's mode — proxied (placeholder, injected), placeholder (sensitive, no
rule), passthrough (real value), or omit — without starting a proxy. Handy for
verifying a schema and seeing what an agent could and couldn't reach.
