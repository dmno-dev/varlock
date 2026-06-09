---
varlock: patch
---

Preserve process.env override provenance across nested invocations so `varlock run`-injected resolved values are no longer treated as true overrides by inner `varlock` loads.

Only real upstream overrides now propagate through nesting, while inner command-local overrides still win as expected.

Also fixes smoke-test CLI resolution to use the workspace-local varlock CLI instead of any globally installed binary.

Note: `__VARLOCK_ENV` now includes override provenance metadata (`__varlockOverrideMeta`). Tooling that strictly validates that blob shape should allow unknown/new fields.
