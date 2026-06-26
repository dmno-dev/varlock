---
varlock: patch
---

`@proxy` supports a `rules=[{...}]` array to group several path/method policies under one domain.

Instead of repeating `domain` on every rule, write it once and list the refinements: `@proxy(domain="api.stripe.com", rules=[{path="/v1/refunds/**", block=true}, {path="/v1/payouts/**", block=true}])`. The parent `@proxy(...)` still controls injection; each entry is a policy-only refinement (it may set `path`/`method`/`block`/`approval`, inherits the domain, and injects nothing).
