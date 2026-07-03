---
varlock: patch
---

Proxy: the schema fingerprint now covers the full schema definition.

The fingerprint that guards an active proxy session against schema drift (and that `varlock proxy reload` re-applies) now hashes each config item's value definitions (pre-resolution: no secrets, no I/O) plus every decorator, and all root decorators, instead of only key/sensitivity/required/type. Cosmetic decorators (`@example`, `@docs`, `@docsUrl`, `@icon`, `@deprecated`) are marked `inert` and excluded, and decorator order, named-arg order, comments, and whitespace don't affect it. This closes gaps where a behavioral change left the fingerprint unchanged, e.g. flipping a secret from `@proxy(domain=…)` to `@proxy=passthrough`, changing a `@proxy` domain, or the egress mode.
