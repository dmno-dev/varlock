---
varlock: patch
---

Add a `require-approval` verdict to the proxy (Invariant #8).

Mark a rule `@proxy(domain="...", approve=true)` and matching requests are held for an out-of-band, request-bound approval before being forwarded. The approval commits to the exact request — method + verified host + path + body hash + nonce + expiry — so a future signed phone-approval relay drops in unchanged. Precedence is block > require-approval > allow (most restrictive wins). The MVP approver is a terminal prompt under `varlock proxy start` (where the proxy owns the terminal; under `varlock proxy run` the child owns stdio, so approval-required requests fail closed). Everything fails closed — denied, timed-out, or unanswerable approvals never reach upstream — and each outcome is recorded in the audit log as `approval-granted` / `approval-denied`.
