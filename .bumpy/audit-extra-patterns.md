---
varlock: minor
---

`varlock audit` can now be taught project-specific env access patterns with `@auditExtraPatterns()`, for code that reads env vars through a wrapper like `configService.get('KEY')`. Add `fileTypes=[tf, yaml]` to a call to limit its patterns to those file types, which is also how the scan reaches file types it skips by default, such as Terraform or Helm values. `@auditIgnorePaths()` and `varlock audit --ignore` can now exclude one specific directory, written as a path (`./apps/docs`, `../`, `~/`, or absolute) instead of only a bare directory name that matches everywhere it appears. A path written without one of those prefixes, or resolving outside the scanned directory, used to silently exclude nothing and is now an error that names the fix. Also fixes the scanner reporting commented-out code inside template literal interpolations (`${/* ... */ ...}`) as live env references.
