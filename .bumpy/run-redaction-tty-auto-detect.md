---
varlock: minor
---

varlock run now auto-detects whether output is attached to an interactive terminal: TTY-attached streams get raw passthrough (interactive tools like psql and claude work without --no-redact-stdout), while piped/redirected output is still redacted. Adds --redact-stdout to force redaction of piped output (errors if output is attached to an interactive terminal, where redaction would break TTY behavior), and fixes a leak where secrets split across stream chunk boundaries escaped redaction.
