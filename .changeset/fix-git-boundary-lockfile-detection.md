---
"varlock": patch
---

Fix plugin resolution failure in monorepo workspaces where `.git` and the lockfile coexist in the same directory.

`detectWorkspaceInfo()` was checking for a `.git` directory **after** moving to the parent, so in the standard monorepo layout (`monorepo-root/.git` + `monorepo-root/bun.lock`) the root was never scanned and the lockfile was never found. Moving the `.git` boundary check to **before** moving up ensures the git-root directory is always scanned first.
