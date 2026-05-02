# @varlock/cloudflare-integration




## 1.1.0
<sub>2026-05-02</sub>

- [#681](https://github.com/dmno-dev/varlock/pull/681) - Add --summary-stderr/--summary-file flags to varlock load and fullResult option to execSyncVarlock

## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.1.1

_2026-04-22_

- [#635](https://github.com/dmno-dev/varlock/pull/635) [`2515c80`](https://github.com/dmno-dev/varlock/commit/2515c805562c993ec26786bd1aa097ade5686a50) Thanks [@app/copilot-swe-agent](https://github.com/app/copilot-swe-agent)! - fix(cloudflare): debounce wrangler restarts and skip when env is unchanged
  `varlock-wrangler dev` now caches the serialized resolved env graph and compares it
  after each debounced watch event. Wrangler only restarts when the resolved env has
  actually changed, preventing restart loops caused by spurious `fs.watch()` events
  on macOS (which can emit events even when file contents are identical).
- [#632](https://github.com/dmno-dev/varlock/pull/632) [`9abdffa`](https://github.com/dmno-dev/varlock/commit/9abdffaa894ce887892211960a60af39d02e434b) - pass through exit-code if set from process to avoid silent fails
## 0.1.0

### Minor Changes

- [#622](https://github.com/dmno-dev/varlock/pull/622) [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617) - Add `varlockSvelteKitCloudflarePlugin` for SvelteKit + Cloudflare Workers projects

  New `varlockSvelteKitCloudflarePlugin` exported from `@varlock/cloudflare-integration/sveltekit` for SvelteKit projects deploying via `@sveltejs/adapter-cloudflare`. Unlike `varlockCloudflareVitePlugin`, it does not include `@cloudflare/vite-plugin` (which doesn't support SvelteKit — see [cloudflare/workers-sdk#8922](https://github.com/cloudflare/workers-sdk/issues/8922)). Instead it injects the `cloudflare:workers` runtime env loader into SvelteKit's SSR entry and externalizes the import so Rollup preserves it in the built `_worker.js`. Non-sensitive vars and the `__VARLOCK_ENV` secret are still uploaded via `varlock-wrangler deploy`.

  Also adds a conflict guard to `varlockCloudflareVitePlugin` that errors when the user has manually added `@cloudflare/vite-plugin` to avoid silent double-registration.

### Patch Changes

- Updated dependencies [[`9c38e3a`](https://github.com/dmno-dev/varlock/commit/9c38e3a06977263a43a35aafdd07c8ba4253a6e0), [`f93c23f`](https://github.com/dmno-dev/varlock/commit/f93c23f15d1cb98f64c2d78de1184fb4edbe5582), [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617)]:
  - varlock@0.9.0

## 0.0.1

### Patch Changes

- [#480](https://github.com/dmno-dev/varlock/pull/480) [`39d88a9`](https://github.com/dmno-dev/varlock/commit/39d88a91be87c7f440e017ff66ebc9c0e5b1c9f9) - New `@varlock/cloudflare-integration` package for Cloudflare Workers

  - `varlockCloudflareVitePlugin()` — Vite plugin that reads secrets from Cloudflare bindings at runtime instead of bundling them into worker code
  - `varlock-wrangler` CLI — drop-in wrangler replacement that uploads non-sensitive values as vars and sensitive values as secrets on deploy; injects env into miniflare via Unix named pipe in dev; watches .env files for changes; generates correct Env types
  - `@varlock/cloudflare-integration/init` — standalone init module for non-Vite workers
    Refactors `@varlock/vite-integration` to remove Cloudflare-specific logic and add generic extension points (`ssrEntryCode`, `ssrEdgeRuntime`, `ssrEntryModuleIds`) for platform integrations.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0
