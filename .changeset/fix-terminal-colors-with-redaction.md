---
"varlock": patch
---

Fix terminal colors when running commands with redaction enabled. When `varlock run` pipes stdout/stderr for redaction, it now automatically injects `FORCE_COLOR` into the child process environment when the parent terminal is a TTY. This preserves color output for tools using color libraries (chalk, kleur, etc.) while keeping redaction active.
