---
varlock: patch
---

Fix: allow `@proxy(...)` in the `.env.schema` header for "detached" proxy rules.

`@proxy` is both an item decorator (attached rules) and a root decorator (detached rules), but the header placement check rejected it as a misplaced item decorator, so detached rules — including header-level `block`/`approve` rules — couldn't be authored. A decorator registered as both is now accepted in the header.
