---
varlock: patch
---

Proxy approvals: per-rule granularity and a max-duration cap.

`@proxy(approval=true)` rules now accept `approvalEach` — how finely to ask: `host`, `endpoint` (method+path), or `request` (method+path+body) — and `approvalMaxDuration`, the ceiling on how long a "yes" is remembered (e.g. `"15m"`, or `0` for always-ask). A standing grant is keyed by the matched rule plus its granularity, so one broad rule can yield per-endpoint or per-exact-request approvals without writing many rules. The cap is enforced proxy-side: the approver's chosen lifetime is clamped to `approvalMaxDuration`, so no approver can exceed what the schema allows (always-ask is provably one-tap-per-request). The `@proxy(approve=…)` option is renamed to `approval`.
