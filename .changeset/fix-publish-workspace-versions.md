---
---

Fix publishing pipeline to resolve `workspace:` and `catalog:` version protocols before `changeset publish`. These were previously resolved automatically by pnpm during publish, but after switching to Bun, `changeset publish` falls back to `npm publish` which doesn't understand these protocols.
