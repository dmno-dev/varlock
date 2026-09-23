---
varlock: patch
---

Fix duplicate encryption daemons, and the repeated Touch ID / Windows Hello prompts they cause, when many varlock processes start at once (an MCP host launching several stdio servers, a parallel task runner). A daemon that lost the startup race could overwrite or delete the running daemon's state files, after which clients treated the live daemon as dead, removed its socket and started a second one alongside it.
