---
varlock: patch
---

Fix duplicate encryption daemons, and the repeated Touch ID / Windows Hello prompts they cause, when many varlock processes start at once (an MCP host launching several stdio servers, a parallel task runner). Switching between projects on different varlock versions now only restarts the daemon when its binary actually differs, so versions that ship the same daemon share one biometric session.
