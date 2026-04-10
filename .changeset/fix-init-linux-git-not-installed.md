---
"varlock": patch
---

Fix `varlock init` crashing on Linux when git is not installed.

When `git` is not found in PATH, Node.js `spawn` fires an `error` event with a native ENOENT error that has no `.data` property. The `checkIsFileGitIgnored` utility was trying to call `.includes()` on the undefined `.data` value before reaching the ENOENT check, causing a `TypeError` that crashed the `init` command.

The fix reorders the error checks to handle the ENOENT case first, and uses optional chaining on the `errorOutput` value throughout for additional safety.
