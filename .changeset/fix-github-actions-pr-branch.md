---
"@varlock/ci-env-info": patch
---

Fix `VARLOCK_BRANCH` returning `refs/pull/123/merge` in GitHub Actions PR workflows.

In GitHub Actions pull request contexts, `GITHUB_REF` is set to the merge ref (e.g. `refs/pull/123/merge`) rather than the branch name. GitHub Actions also provides `GITHUB_HEAD_REF` which contains the actual PR head branch name (e.g. `feat-init-infra`).

Changes:
- Updated GitHub Actions platform branch extractor to prefer `GITHUB_HEAD_REF` when available, falling back to `refToBranch(GITHUB_REF)` for non-PR contexts
- Fixed `refToBranch()` to return `undefined` for `refs/pull/` refs instead of returning the raw merge ref string
