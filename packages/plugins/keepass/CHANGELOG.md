# @varlock/keepass-plugin


## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.2

### Patch Changes

- [#413](https://github.com/dmno-dev/varlock/pull/413) [`7b04b21`](https://github.com/dmno-dev/varlock/commit/7b04b21da323807d9a54d7a8441f64930136b7c0) Thanks [@qades](https://github.com/qades)! - Add KeePass plugin for loading secrets from KDBX 4.0 databases.

  - `kp()` resolver with `#attribute` syntax, entry name inference from key, and `customAttributesObj` for bulk custom field loading
  - `kpBulk()` resolver for loading all passwords from a group via `@setValuesBulk`
  - `kdbxPassword` data type for master password validation
  - File mode using kdbxweb with pure WASM argon2 (no native addons, works in SEA builds)
  - CLI mode via `keepassxc-cli` with dynamic `useCli` option (e.g., `useCli=forEnv(dev)`)
  - Multiple database instances via `id` param
  - Key file authentication support
  - Add `input` option to `spawnAsync` for streaming stdin to child processes

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0
