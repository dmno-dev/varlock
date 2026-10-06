---
varlock: patch
---

`varlock run` and `varlock proxy run` no longer print a failure hint to stdout when the child exits non-zero; the child's exit code is passed through silently. A command that cannot be started is reported on stderr (exit 127 when not found, 126 when not executable)
