---
varlock: patch
---

plugin-registered data types can now declare `coercedType` so generated env modules type their fields correctly (previously they always emitted as strings)
