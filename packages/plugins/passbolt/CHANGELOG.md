# @varlock/passbolt-plugin



## 1.1.0
<sub>2026-06-10</sub>

- [#577](https://github.com/dmno-dev/varlock/pull/577)  *(minor)* - Add opt-in disk caching via the `cacheTtl` init param (e.g. `cacheTtl="1h"`, `cacheTtl=forever`; setting it to `false` or an empty string disables caching). Cache keys include a hash of the account-identifying instance config (account, region, project, environment, etc.) so projects pointing the same plugin at different backends can never read each other's cached values from the shared per-user cache.
  Akeyless caches static secret values only — dynamic and rotated secrets are designed to change per fetch and are never cached.

## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.1

### Patch Changes

- [#498](https://github.com/dmno-dev/varlock/pull/498) [`1ece84a`](https://github.com/dmno-dev/varlock/commit/1ece84ac5216b3b146ce98b220ae3376c1e20039) Thanks [@PaddeK](https://github.com/PaddeK)! - Adding varlock plugin for Passbolt Secrets Manager
