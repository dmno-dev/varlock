# @varlock/kubernetes-plugin




## 1.0.1
<sub>2026-08-25</sub>

- [#987](https://github.com/dmno-dev/varlock/pull/987)  *(patch)*
  Fix package.json entry points - remove references to files that were never built and declare import/require conditions explicitly
- [#1021](https://github.com/dmno-dev/varlock/pull/1021)  *(patch)* - Build with tsdown instead of tsup; published files now use explicit .mjs/.cjs extensions.

## 1.0.0
<sub>2026-06-23</sub>

- [#817](https://github.com/dmno-dev/varlock/pull/817)  *(major)* - **Breaking:** the service-account / auth token data types are now `@internal` by default — varlock still uses them to fetch your other secrets, but they are no longer injected into your application. If your app reads one of these credentials directly (e.g. to write secrets back or fetch more at runtime), set `@internal=false` to keep it injected.
- [#818](https://github.com/dmno-dev/varlock/pull/818)  *(patch)* - Report anonymous, non-sensitive usage attributes (auth mode, feature flags) through varlock's opt-out telemetry.

## 0.1.0
<sub>2026-06-03</sub>

- [#737](https://github.com/dmno-dev/varlock/pull/737)  *(minor)* Thanks [@idorozin](https://github.com/idorozin)! - Add a Kubernetes plugin for reading Secrets and ConfigMaps.

## 0.1.0

- Initial Kubernetes plugin for reading values from Secrets and ConfigMaps.
