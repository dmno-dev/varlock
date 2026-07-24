---
varlock: patch
---

plugins now work in shell-less/distroless images: tarballs extract natively (no `tar`/shell dependency), and `varlock flatten --vendor-plugins` downloads plugins into the output for a fully self-contained artifact
