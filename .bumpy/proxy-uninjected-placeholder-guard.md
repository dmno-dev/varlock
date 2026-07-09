---
varlock: patch
---

The proxy now fails helpfully instead of forwarding a doomed request: if a request carries a placeholder that no `@proxy` rule injects on that route (e.g. the path didn't match), it's blocked with a message naming the item and the rule gap — so a mismatched rule reads as "fix the proxy rule," not a mystery `401` from the upstream.
