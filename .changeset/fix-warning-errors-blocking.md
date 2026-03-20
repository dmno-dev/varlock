---
"varlock": patch
---

fix: warning-level schema errors no longer block plugin loading or item resolution

Warning errors (e.g., deprecated syntax warnings) were incorrectly treated as hard errors in several places, causing early bail-outs that prevented plugins from loading and items from resolving. Fixed `isValid`, `finishLoad`, and decorator `resolve` checks to filter out warnings.
