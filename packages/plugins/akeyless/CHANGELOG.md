# @varlock/akeyless-plugin




## 1.2.0
<sub>2026-06-10</sub>

- [#577](https://github.com/dmno-dev/varlock/pull/577)  *(minor)* - Add opt-in disk caching via the `cacheTtl` init param (e.g. `cacheTtl="1h"`, `cacheTtl=forever`; setting it to `false` or an empty string disables caching). Cache keys include a hash of the account-identifying instance config (account, region, project, environment, etc.) so projects pointing the same plugin at different backends can never read each other's cached values from the shared per-user cache.
  Akeyless caches static secret values only — dynamic and rotated secrets are designed to change per fetch and are never cached.

## 1.1.0
<sub>2026-05-06</sub>

- [#636](https://github.com/dmno-dev/varlock/pull/636) - add OIDC workload identity federation support to secret provider plugins

## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.2

### Patch Changes

- [#544](https://github.com/dmno-dev/varlock/pull/544) [`d1925f0`](https://github.com/dmno-dev/varlock/commit/d1925f07e3e61e952c66d79b08545ec13676ec9c) - Add Akeyless plugin for loading secrets from Akeyless Platform. Supports API Key authentication, static/dynamic/rotated secrets, self-hosted gateway, multiple instances, and automatic token caching.

- Updated dependencies [[`9c38e3a`](https://github.com/dmno-dev/varlock/commit/9c38e3a06977263a43a35aafdd07c8ba4253a6e0), [`f93c23f`](https://github.com/dmno-dev/varlock/commit/f93c23f15d1cb98f64c2d78de1184fb4edbe5582), [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617)]:
  - varlock@0.9.0
