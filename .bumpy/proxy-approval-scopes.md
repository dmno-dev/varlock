---
varlock: patch
---

Proxy approvals: approve once, for the session, or for a time window.

The `require-approval` terminal prompt (`varlock proxy start`) now offers scopes — `[y] once`, `[s] this session`, `[m] 15 min` — instead of a plain yes/no. A session- or duration-scoped approval is remembered as a standing grant (stored per session, no secret values) so later requests matching the same `@proxy(approve=true)` rule are auto-approved without re-prompting. Grants are decoupled from the approver behind a store, so the future phone / native-app approver reuses the same mechanism.
