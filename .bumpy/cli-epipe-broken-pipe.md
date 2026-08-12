---
varlock: patch
---

Exit cleanly instead of crashing when CLI output is piped into a consumer that closes early (e.g. `varlock flatten | head -3`)
