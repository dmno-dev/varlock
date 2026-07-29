---
"@varlock/dashlane-plugin": minor
---

dashlane() no longer hangs forever on a locked vault: dcli calls run with stdin closed and a timeout (default 30s). New @initDashlane options: onLocked=error|warn and timeoutMs
