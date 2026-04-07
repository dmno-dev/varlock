# @varlock/1password-plugin

## 0.3.3

### Patch Changes

- [#533](https://github.com/dmno-dev/varlock/pull/533) [`0b6b2c0`](https://github.com/dmno-dev/varlock/commit/0b6b2c03ea5170f2ad1fbfa536b1b94ccf1de500) - Add support for 1Password Connect server (self-hosted)

  - New auth mode: `connectHost` + `connectToken` parameters in `@initOp()` for connecting to self-hosted 1Password Connect servers
  - Direct REST API integration — no `op` CLI or 1Password SDK required for Connect server usage
  - New `opConnectToken` data type for Connect server API tokens
  - Parses standard `op://vault/item/[section/]field` references and resolves them via the Connect API
  - Caches vault and item ID lookups within a session for efficiency
  - Clear error when `opLoadEnvironment()` is used with Connect (not supported by the Connect API)
  - Updated error messages and tips to include Connect server as an auth option

- Updated dependencies [[`2022ef7`](https://github.com/dmno-dev/varlock/commit/2022ef7c8b2070f40c0cd787f0cc75a595a679e4), [`74752a3`](https://github.com/dmno-dev/varlock/commit/74752a3db9459538b8ef7d984737f5bb55de17ae), [`0ea6641`](https://github.com/dmno-dev/varlock/commit/0ea66411604966f744e311fdf59df71d5a3da127), [`6ab2d31`](https://github.com/dmno-dev/varlock/commit/6ab2d31903b80ab4d8ec0eb826a18789e73e8f11), [`01c9a6a`](https://github.com/dmno-dev/varlock/commit/01c9a6a5398d31d3818953dd757d3263e0cf3a36), [`1a4b0cf`](https://github.com/dmno-dev/varlock/commit/1a4b0cf4185c4152be4b39c70755316f1a8be25d), [`02e82d0`](https://github.com/dmno-dev/varlock/commit/02e82d07b4b9d810dba8d1925a27d9fd2c0abab3), [`0c27ed1`](https://github.com/dmno-dev/varlock/commit/0c27ed10b3b77571848974a3703d77e1eabb8abd)]:
  - varlock@0.7.2

## 0.3.2

### Patch Changes

- [#522](https://github.com/dmno-dev/varlock/pull/522) [`6bdf398`](https://github.com/dmno-dev/varlock/commit/6bdf3989d90a27579623f4e185090acdc08c5e16) - remove unnecessary import causing imcompatibility error

## 0.3.1

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

- [#513](https://github.com/dmno-dev/varlock/pull/513) [`3a480b2`](https://github.com/dmno-dev/varlock/commit/3a480b242e318b9abdeb5ee429a547913d2e6eb1) - - fix: `checkOpCliAuth()` now always returns a completion callback (a no-op after the mutex is already settled) so follow-up `op` CLI paths still signal success/failure correctly; previously only the first call returned the deferred `resolve` function.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0

## 0.3.0

### Minor Changes

- [#438](https://github.com/dmno-dev/varlock/pull/438) [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4) - general cleanup and standardization of plugins

  feat: add `standardVars` plugin property for automatic env var detection warnings

  Plugins can now declaratively set `plugin.standardVars` to define well-known env vars they use. The loading infrastructure automatically checks for these vars in the environment and shows non-blocking warnings (in pretty output or on failure) when they are detected but not wired into the schema or plugin decorator. Green highlighting indicates items that need to be added.

### Patch Changes

- [#436](https://github.com/dmno-dev/varlock/pull/436) [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac) - fix: switch plugins to CJS output to fix plugin loading errors in the standalone binary

  Previously plugins were built as ESM and the loader performed a fragile regex-based ESM→CJS transformation. Plugins now build as CJS directly and are loaded via `new Function` in the main runtime context, which avoids both the ESM parse errors and Node.js internal assertion failures (e.g. `DOMException` lazy getter crashing in vm sandbox contexts).

- [#415](https://github.com/dmno-dev/varlock/pull/415) [`29316c5`](https://github.com/dmno-dev/varlock/commit/29316c5703f0bad7780c3af024bfa8b496eac68b) - fix: use `fileURLToPath` instead of `.pathname` to derive `__dirname` in plugin ESM banner, preventing doubled drive letters (`C:\C:\...`) on Windows

- Updated dependencies [[`7b31afe`](https://github.com/dmno-dev/varlock/commit/7b31afecf9b571452be87c86f9ef54731235c06e), [`dbf0bd4`](https://github.com/dmno-dev/varlock/commit/dbf0bd4fb46918cafb7b72cb0cfd4bbc9132b3d3), [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac), [`1e8bca6`](https://github.com/dmno-dev/varlock/commit/1e8bca69b0f455ed58390545a1f9cbfb90d92131), [`ab417d7`](https://github.com/dmno-dev/varlock/commit/ab417d772ed06d671060a16273f33c1503e44333), [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4)]:
  - varlock@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [[`4d436ff`](https://github.com/dmno-dev/varlock/commit/4d436ff42863136fb5ebb7016e525ef54732ea20), [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa)]:
  - varlock@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`e30ec1f`](https://github.com/dmno-dev/varlock/commit/e30ec1f6c193365903c734f9443dea0ae420c9bb)]:
  - varlock@0.4.0

## 0.2.1

### Patch Changes

- [#307](https://github.com/dmno-dev/varlock/pull/307) [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39) - add 1password environments loader, improve how resolver errors are shown to the user

- Updated dependencies [[`1a42d3f`](https://github.com/dmno-dev/varlock/commit/1a42d3f88c89a136f3745a1586e9b43bc9b7b069), [`6b64a4f`](https://github.com/dmno-dev/varlock/commit/6b64a4fce63e951d116b2ad5df3027906e9b9f8f), [`98fccd6`](https://github.com/dmno-dev/varlock/commit/98fccd6c2ce48897bbe3db1aad9191171c4a84f2), [`9d8302f`](https://github.com/dmno-dev/varlock/commit/9d8302f2397abef7b49a62d1700f1339be8aa8d9), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39), [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206), [`ccff56b`](https://github.com/dmno-dev/varlock/commit/ccff56b6fba018c3e30d3f91261a4a03c1548c6d), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39)]:
  - varlock@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`c872e71`](https://github.com/dmno-dev/varlock/commit/c872e7169b71d73043104ca9e345a03accc24650), [`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d), [`15b9c81`](https://github.com/dmno-dev/varlock/commit/15b9c81ac4941c4dbefb38812d0701274f4b4dad), [`e5c7d24`](https://github.com/dmno-dev/varlock/commit/e5c7d24b59c6dd01780bf655cb0edb616d38c301), [`bcba478`](https://github.com/dmno-dev/varlock/commit/bcba4788ca35f58c4c54266aba728c0d603617d2), [`558360a`](https://github.com/dmno-dev/varlock/commit/558360a99b72fd5a5a875e71cc6772ec13ffd936), [`50c4ad4`](https://github.com/dmno-dev/varlock/commit/50c4ad426d4e5fc90f9bee02c6b4c683433a733c), [`c0d9942`](https://github.com/dmno-dev/varlock/commit/c0d994297289206c6f9516151a313b0a429dc454)]:
  - varlock@0.2.0

## 0.1.0

### Minor Changes

- [#188](https://github.com/dmno-dev/varlock/pull/188) [`dcbf55d`](https://github.com/dmno-dev/varlock/commit/dcbf55d099c593fa066b4469dc012a7809a89f35) - re-release 1pass plugin w/ minor version

- [#168](https://github.com/dmno-dev/varlock/pull/168) [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8) - unify resolvers with decorators, new plugin system, 1pass plugin

- Updated dependencies [[`8bae875`](https://github.com/dmno-dev/varlock/commit/8bae875503c5f9a9d84bc772ad41be1fb3e4febd), [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8)]:
  - varlock@0.1.0
