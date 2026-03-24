---
"varlock": patch
---

Fix: `varlock load --format shell` now properly escapes special characters in values.

Values are now wrapped in single quotes instead of double quotes, preventing shell injection via backticks, `$()` subshell syntax, and variable expansion (`$VAR`). Single quotes within values are safely escaped using the `'\''` sequence.
