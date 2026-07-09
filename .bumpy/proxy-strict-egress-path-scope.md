---
varlock: patch
---

`egress="strict"` now blocks a request to a routed host when no `@proxy` rule matches its path/method (previously such requests passed through unproxied). The block response explains that the host has a rule but none matches this method + path, distinct from the "no rule for this host" and "denied by a block rule" messages.
