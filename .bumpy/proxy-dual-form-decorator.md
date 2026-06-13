---
varlock: patch
---

Proxy: unify `@proxyPassthrough` into a dual-form `@proxy` decorator.

`@proxy` can now be used as a function — `@proxy(domain=...)` to route a value through the proxy (the agent sees a placeholder) — or as a value: `@proxy=passthrough` injects the real value into the proxied child, and `@proxy=omit` explicitly withholds it (no "no policy set" warning). The two forms are mutually exclusive on a single item. This replaces the separate `@proxyPassthrough` decorator.
