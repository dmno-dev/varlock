---
varlock: minor
---

`varlock audit` can now be taught project-specific env access patterns via `@auditExtraPatterns()`. Add `fileTypes=[tf, yaml]` to a call to apply its patterns only to those file types, which also lets the scan reach file types it skips by default (Terraform, YAML, shell, ...). Also fixes the code scanner treating commented-out code inside template literal interpolations (`${/* ... */ ...}`) as live env references.
