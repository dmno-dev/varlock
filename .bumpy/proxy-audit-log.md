---
varlock: patch
---

Add an append-only audit log for proxy sessions (Invariant #7).

Every proxied request now records one JSON line — timestamp, host, method, path, a request fingerprint hash, the matched rule, the decision (allow / deny / blocked-egress / blocked-cleartext), and which managed items were injected (by key name). No secret values, query strings, or request bodies are ever written. Logs are stored per session under `~/.config/varlock/proxy/audit/<uuid>.jsonl` and persist after the session ends. View them with `varlock proxy audit [--session <id>] [--format text|json]`.
