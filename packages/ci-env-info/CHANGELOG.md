# @varlock/ci-env-info

## 0.0.2

### Patch Changes

- [#566](https://github.com/dmno-dev/varlock/pull/566) [`012ed3f`](https://github.com/dmno-dev/varlock/commit/012ed3fd8a290572872200cb8d73a56616e9047d) - Fix `VARLOCK_BRANCH` returning `refs/pull/123/merge` in GitHub Actions PR workflows.

  In GitHub Actions pull request contexts, `GITHUB_REF` is set to the merge ref (e.g. `refs/pull/123/merge`) rather than the branch name. GitHub Actions also provides `GITHUB_HEAD_REF` which contains the actual PR head branch name (e.g. `feat-init-infra`).

  Changes:

  - Updated GitHub Actions platform branch extractor to prefer `GITHUB_HEAD_REF` when available, falling back to `refToBranch(GITHUB_REF)` for non-PR contexts
  - Fixed `refToBranch()` to return `undefined` for `refs/pull/` refs instead of returning the raw merge ref string

## 0.0.1

### Patch Changes

- [#285](https://github.com/dmno-dev/varlock/pull/285) [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206) - new auto-inferred VARLOCK_ENV from ci info (uses new ci-env-info package)
