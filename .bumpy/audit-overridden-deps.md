---
varlock: patch
---

Fix `varlock audit` reporting a referenced item as unused when the item referencing it is overridden, either from the process environment or by a higher-priority file
