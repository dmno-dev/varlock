# @varlock/pass-plugin


## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.0.6

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

## 0.0.5

### Patch Changes

- [#436](https://github.com/dmno-dev/varlock/pull/436) [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac) - fix: switch plugins to CJS output to fix plugin loading errors in the standalone binary

  Previously plugins were built as ESM and the loader performed a fragile regex-based ESM→CJS transformation. Plugins now build as CJS directly and are loaded via `new Function` in the main runtime context, which avoids both the ESM parse errors and Node.js internal assertion failures (e.g. `DOMException` lazy getter crashing in vm sandbox contexts).

- Updated dependencies [[`7b31afe`](https://github.com/dmno-dev/varlock/commit/7b31afecf9b571452be87c86f9ef54731235c06e), [`dbf0bd4`](https://github.com/dmno-dev/varlock/commit/dbf0bd4fb46918cafb7b72cb0cfd4bbc9132b3d3), [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac), [`1e8bca6`](https://github.com/dmno-dev/varlock/commit/1e8bca69b0f455ed58390545a1f9cbfb90d92131), [`ab417d7`](https://github.com/dmno-dev/varlock/commit/ab417d772ed06d671060a16273f33c1503e44333), [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4)]:
  - varlock@0.6.0

## 0.0.4

### Patch Changes

- Updated dependencies [[`4d436ff`](https://github.com/dmno-dev/varlock/commit/4d436ff42863136fb5ebb7016e525ef54732ea20), [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa)]:
  - varlock@0.5.0

## 0.0.3

### Patch Changes

- Updated dependencies [[`e30ec1f`](https://github.com/dmno-dev/varlock/commit/e30ec1f6c193365903c734f9443dea0ae420c9bb)]:
  - varlock@0.4.0

## 0.0.2

### Patch Changes

- [#321](https://github.com/dmno-dev/varlock/pull/321) [`09cef12`](https://github.com/dmno-dev/varlock/commit/09cef1225dfdbc0c836a798b96354bbde657a1f8) - Initial version of pass plugin - load secrets from pass (the standard unix password manager)
