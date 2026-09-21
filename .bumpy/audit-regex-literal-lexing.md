---
varlock: patch
---

`varlock audit` now lexes regex literals in JS/TS (and Ruby) source, so a regex containing a quote (such as `s.replace(/'/g, "")`) no longer hides every env var reference that follows it in the same file. Slashes in JSX text and closing tags are treated as plain text, not regexes.
