---
"@varlock/dashlane-plugin": minor
---

dashlane() no longer hangs forever on a locked vault: dcli calls run with stdin closed and a timeout (default 30s, configurable via @initDashlane(timeoutMs=...)). New allowMissing option (per item or in @initDashlane) resolves missing vault entries as empty instead of failing
