---
varlock: patch
---

Proxy sessions are kept as a durable record instead of deleted on stop.

Each session now lives in its own directory (`proxy/sessions/<id>/`) holding its `session.json`, `audit.jsonl`, and `grants.jsonl` together. Stopping a session marks it ended rather than deleting it, so its audit log and approval grants survive for later inspection. `proxy status` shows active sessions by default; pass `--all` to include ended ones.
