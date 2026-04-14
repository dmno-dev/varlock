---
"varlock": minor-isolated
---

In non-CI environments, `VARLOCK_BRANCH` now auto-detects the current git branch via `git branch --show-current`. Previously it was only populated in CI environments from platform environment variables.
