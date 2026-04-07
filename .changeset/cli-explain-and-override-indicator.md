---
"varlock": minor
---

Add `varlock explain ITEM_KEY` command and override indicators in `varlock load` output.

**Override indicators**: When a config item's value comes from a `process.env` override rather than its file-based definitions, `varlock load` now shows a yellow indicator on that item. This helps users understand why their resolver functions (e.g. `op()`) are not being called.

**`varlock explain` command**: Shows detailed information about how a single config item is resolved, including all definitions and sources in priority order, which source is active, whether a process.env override is in effect (and what would be used without it), decorators, type info, and documentation links.
