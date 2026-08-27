---
varlock: minor
---

Behavior change: schema items that resolve to undefined are no longer injected into process.env as empty strings by auto-load, matching `varlock run` and the documented `VAR=` semantics (so `process.env.MY_VAR ?? 'fallback'` works). `varlock load --format shell` now also skips them. If your code relies on unset vars being `""`, add `# @injectUndefinedAsEmpty` to your `.env.schema` header to restore the old behavior; when set, generated types mark process.env keys as always-present strings (optional enums become `"a" | "b" | ""`).
