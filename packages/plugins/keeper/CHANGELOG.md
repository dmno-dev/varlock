# @varlock/keeper-plugin


## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.2

### Patch Changes

- [#545](https://github.com/dmno-dev/varlock/pull/545) [`c1b0943`](https://github.com/dmno-dev/varlock/commit/c1b0943bbd4d0b924087dfad354c0281171a9ae9) - Add Keeper Security plugin for loading secrets from Keeper vaults via the Secrets Manager SDK. Supports fetching secrets by record UID, title, or Keeper notation syntax, with access to both standard and custom fields. Includes `keeperSmToken` data type for config token validation, `@initKeeper()` root decorator for initialization, and `keeper()` resolver function for secret retrieval.

- Updated dependencies [[`9c38e3a`](https://github.com/dmno-dev/varlock/commit/9c38e3a06977263a43a35aafdd07c8ba4253a6e0), [`f93c23f`](https://github.com/dmno-dev/varlock/commit/f93c23f15d1cb98f64c2d78de1184fb4edbe5582), [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617)]:
  - varlock@0.9.0
