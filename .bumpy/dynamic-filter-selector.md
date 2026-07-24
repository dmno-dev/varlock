---
varlock: minor
---

Add `@dynamic` selector to the `--filter` language (`!@dynamic` selects static items). Decorator-based filters (`@dynamic`/`@sensitive`/`@required`) now scope resolution and validation to selected items, so e.g. a build-time `--filter='!@dynamic'` skips runtime-only vars entirely, including their `@required` checks
