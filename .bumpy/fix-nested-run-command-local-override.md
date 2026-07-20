---
"varlock": patch
---

Fix nested `varlock run`: a command-local override (`FOO=bar varlock ...`) inside a parent `varlock run` now wins over the parent's injected value again, instead of being clobbered by the re-injected env blob.
