# @varlock/proton-pass-plugin


## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.3

### Patch Changes

- [#483](https://github.com/dmno-dev/varlock/pull/483) [`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5) - Add support for single-file ESM and TypeScript plugins, and improve the plugin authoring API.

  **New: ESM and TypeScript single-file plugins**

  Single-file plugins can now be written as `.mjs` or `.ts` files in addition to `.js`/`.cjs`. TypeScript plugins require Bun.

  **Improved: explicit `plugin` import instead of injected global**

  Plugin authors should now import `plugin` explicitly from `varlock/plugin-lib` rather than relying on the injected global:

  ```js
  // CJS plugin (.js / .cjs)
  const { plugin } = require("varlock/plugin-lib");

  // ESM plugin (.mjs / .ts)
  import { plugin } from "varlock/plugin-lib";
  ```

  This works in both regular installs and SEA binary builds. Error classes (`ValidationError`, `CoercionError`, etc.) are also now directly importable from `varlock/plugin-lib`.

  **Breaking change:** the implicit `plugin` global is no longer injected into CJS plugin modules. Existing plugins must add `const { plugin } = require('varlock/plugin-lib')`.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0

## 0.0.2

### Patch Changes

- [#487](https://github.com/dmno-dev/varlock/pull/487) [`1b466b6`](https://github.com/dmno-dev/varlock/commit/1b466b6e710aed5d926a9d25c854dfc51b66f7d8) - Add proton pass plugin

- Updated dependencies [[`2959826`](https://github.com/dmno-dev/varlock/commit/2959826c6c89c732a9318cfe037dd928813c50b7), [`0ca309d`](https://github.com/dmno-dev/varlock/commit/0ca309dea1ecabfc456d01679064f2862dd75809), [`583c2f8`](https://github.com/dmno-dev/varlock/commit/583c2f8405db8c60915767990d12f9469e34ffcb), [`80c0475`](https://github.com/dmno-dev/varlock/commit/80c04751e5cd58bb185ddac50386490ea20479cd)]:
  - varlock@0.6.4

## 0.0.1

### Patch Changes

- Initial plugin scaffold: Proton Pass CLI wrapper
