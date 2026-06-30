---
varlock: patch
---

Proxy: show the agent a placeholder for every sensitive item by default.

Inside `varlock proxy run|start`, any `@sensitive` item the agent sees is replaced with a placeholder — the `@proxy(domain=...)`-routed ones (whose real value is injected at the wire) plus every other sensitive item (which simply isn't injected anywhere). The real value never reaches the child. Use `@proxy=passthrough` to inject the real value (escape hatch) or `@proxy=omit` to withhold an item entirely. Varlock's own `_VARLOCK_*` reserved keys are internal infrastructure and are excluded from this policy.
