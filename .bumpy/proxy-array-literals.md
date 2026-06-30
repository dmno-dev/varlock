---
varlock: patch
---

`@proxy` uses array literals for lists.

`domain` and `method` now accept an array literal for matching multiple values (`domain=[api.a.com, api.b.com]`, `method=[GET, POST]`), and a detached rule attaches extra items with `keys=[ITEM_A, ITEM_B]` instead of positional `$REF`s. A single value still works (`domain="api.x.com"`).
