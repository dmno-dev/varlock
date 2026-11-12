---
varlock: patch
---

Fix `varlock run` and `varlock proxy run` dropping piped output: output still unread when the command exits, output from background processes it started, and output that a slow reader had not consumed within 1 second
