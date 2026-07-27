---
varlock: patch
---

Cache locks left behind by an interrupted run are now reclaimed immediately instead of stalling later runs for several minutes and hiding the real error. `varlock cache clear` also clears locks.
