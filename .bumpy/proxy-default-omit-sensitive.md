---
varlock: patch
---

Proxy: omit unhandled sensitive items by default instead of blocking the session.

Previously `varlock proxy run|start` refused to start if any sensitive item wasn't `@proxy`-managed or `@proxyPassthrough`. Now such items are simply withheld from the proxied child — dropped from both the injected vars and the `__VARLOCK_ENV` blob — with a warning at startup listing the omitted vars. Least privilege by default: the agent only ever sees secrets you explicitly route with `@proxy(...)` (as a placeholder) or `@proxyPassthrough` (the real value), and you no longer have to annotate every other secret just to start a session.
