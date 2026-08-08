# @varlock/dashlane-plugin




## 2.1.0
<sub>2026-08-08</sub>

- [#989](https://github.com/dmno-dev/varlock/pull/989)  *(minor)*
  dashlane() no longer hangs forever on a locked vault: dcli calls run with stdin closed and a timeout (default 30s, configurable via @initDashlane(timeoutMs=...)). New allowMissing option (per item or in @initDashlane) resolves missing vault entries as empty instead of failing

## 2.0.0
<sub>2026-06-23</sub>

- [#817](https://github.com/dmno-dev/varlock/pull/817)  *(major)* - **Breaking:** the service-account / auth token data types are now `@internal` by default — varlock still uses them to fetch your other secrets, but they are no longer injected into your application. If your app reads one of these credentials directly (e.g. to write secrets back or fetch more at runtime), set `@internal=false` to keep it injected.
- [#818](https://github.com/dmno-dev/varlock/pull/818)  *(patch)* - Report anonymous, non-sensitive usage attributes (auth mode, feature flags) through varlock's opt-out telemetry.

## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.1

### Patch Changes

- [#501](https://github.com/dmno-dev/varlock/pull/501) [`79a5ce4`](https://github.com/dmno-dev/varlock/commit/79a5ce44b1bec6f9a69d3f4c767bf3829e42e8f5) Thanks [@LucasPicoli](https://github.com/LucasPicoli)! - feat: add Dashlane plugin
