# @varlock/cloudflare-integration

## 0.0.1

### Patch Changes

- [#480](https://github.com/dmno-dev/varlock/pull/480) [`39d88a9`](https://github.com/dmno-dev/varlock/commit/39d88a91be87c7f440e017ff66ebc9c0e5b1c9f9) - New `@varlock/cloudflare-integration` package for Cloudflare Workers

  - `varlockCloudflareVitePlugin()` — Vite plugin that reads secrets from Cloudflare bindings at runtime instead of bundling them into worker code
  - `varlock-wrangler` CLI — drop-in wrangler replacement that uploads non-sensitive values as vars and sensitive values as secrets on deploy; injects env into miniflare via Unix named pipe in dev; watches .env files for changes; generates correct Env types
  - `@varlock/cloudflare-integration/init` — standalone init module for non-Vite workers
    Refactors `@varlock/vite-integration` to remove Cloudflare-specific logic and add generic extension points (`ssrEntryCode`, `ssrEdgeRuntime`, `ssrEntryModuleIds`) for platform integrations.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0
