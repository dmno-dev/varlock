---
varlock: minor
---

Add --sensitive / --non-sensitive flags to `varlock load` to filter output to only sensitive or non-sensitive items (e.g. `varlock load --format env --sensitive | fly secrets import`)
