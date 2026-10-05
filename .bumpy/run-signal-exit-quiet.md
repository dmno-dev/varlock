---
varlock: patch
---

`varlock run` and `varlock proxy run` no longer print a "command failed" error when the child handles Ctrl+C (or another forwarded signal) and exits non-zero, e.g. 130
