---
"varlock": patch
---

Strip a trailing CRLF from `exec()` output, not only LF. Previously a Windows command's line ending left a stray carriage return in the value.
