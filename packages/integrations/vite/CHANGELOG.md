# @varlock/vite-integration


## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.2.10

### Patch Changes

- [#542](https://github.com/dmno-dev/varlock/pull/542) [`02e82d0`](https://github.com/dmno-dev/varlock/commit/02e82d07b4b9d810dba8d1925a27d9fd2c0abab3) - Fix Vitest workspace projects in monorepos: when running Vitest from the monorepo root using the `projects` config, varlock now correctly resolves `.env.schema` and `.env` files from each child package's directory instead of only looking in the monorepo root.

- Updated dependencies [[`2022ef7`](https://github.com/dmno-dev/varlock/commit/2022ef7c8b2070f40c0cd787f0cc75a595a679e4), [`74752a3`](https://github.com/dmno-dev/varlock/commit/74752a3db9459538b8ef7d984737f5bb55de17ae), [`0ea6641`](https://github.com/dmno-dev/varlock/commit/0ea66411604966f744e311fdf59df71d5a3da127), [`6ab2d31`](https://github.com/dmno-dev/varlock/commit/6ab2d31903b80ab4d8ec0eb826a18789e73e8f11), [`01c9a6a`](https://github.com/dmno-dev/varlock/commit/01c9a6a5398d31d3818953dd757d3263e0cf3a36), [`1a4b0cf`](https://github.com/dmno-dev/varlock/commit/1a4b0cf4185c4152be4b39c70755316f1a8be25d), [`02e82d0`](https://github.com/dmno-dev/varlock/commit/02e82d07b4b9d810dba8d1925a27d9fd2c0abab3), [`0c27ed1`](https://github.com/dmno-dev/varlock/commit/0c27ed10b3b77571848974a3703d77e1eabb8abd)]:
  - varlock@0.7.2

## 0.2.9

### Patch Changes

- [#527](https://github.com/dmno-dev/varlock/pull/527) [`e67ee2f`](https://github.com/dmno-dev/varlock/commit/e67ee2f5c6b09b91564eba3925de560c12ca80c3) - Improve invalid config handling in CLI and Vite integration

  - `varlock load --format json-full` now outputs partial JSON (with `errors` field) even when validation fails, enabling consumers to access sources and valid config items
  - Vite plugin gracefully handles invalid config in dev mode: shows error page and automatically recovers when the config is fixed
  - Vite build output now includes specific error details when config validation fails

- Updated dependencies [[`0d25aa5`](https://github.com/dmno-dev/varlock/commit/0d25aa5e6973e9fc0cf5054e444c0ded28a186f0), [`004e181`](https://github.com/dmno-dev/varlock/commit/004e181ec44251a75be45efafc85846bb3874467), [`e67ee2f`](https://github.com/dmno-dev/varlock/commit/e67ee2f5c6b09b91564eba3925de560c12ca80c3)]:
  - varlock@0.7.1

## 0.2.8

### Patch Changes

- [#480](https://github.com/dmno-dev/varlock/pull/480) [`39d88a9`](https://github.com/dmno-dev/varlock/commit/39d88a91be87c7f440e017ff66ebc9c0e5b1c9f9) - New `@varlock/cloudflare-integration` package for Cloudflare Workers

  - `varlockCloudflareVitePlugin()` — Vite plugin that reads secrets from Cloudflare bindings at runtime instead of bundling them into worker code
  - `varlock-wrangler` CLI — drop-in wrangler replacement that uploads non-sensitive values as vars and sensitive values as secrets on deploy; injects env into miniflare via Unix named pipe in dev; watches .env files for changes; generates correct Env types
  - `@varlock/cloudflare-integration/init` — standalone init module for non-Vite workers
    Refactors `@varlock/vite-integration` to remove Cloudflare-specific logic and add generic extension points (`ssrEntryCode`, `ssrEdgeRuntime`, `ssrEntryModuleIds`) for platform integrations.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0

## 0.2.7

### Patch Changes

- [#459](https://github.com/dmno-dev/varlock/pull/459) [`763b4fc`](https://github.com/dmno-dev/varlock/commit/763b4fc24be6ab148bbaaf99cb1fb1511129d5cd) - detect cloudflare/worker-entry as additional entry point

- [#453](https://github.com/dmno-dev/varlock/pull/453) [`bb1c075`](https://github.com/dmno-dev/varlock/commit/bb1c0755dc826a7322ecbbfa26c01c1b99f2bcb1) - Add support for configuring the default env file load path via `package.json`.

  You can now set a `varlock.loadPath` key in your `package.json` to configure the default path used when loading `.env` files:

  ```json title="package.json"
  {
    "varlock": {
      "loadPath": "./envs/"
    }
  }
  ```

  This is useful when you store your `.env` files in a custom directory (e.g., when using Vite's `envDir` option). The CLI `--path` flag continues to override this setting when provided.

  The Vite integration will also now show a warning if `envDir` is set in your Vite config, with instructions to use `varlock.loadPath` in `package.json` instead.

- Updated dependencies [[`bb1c075`](https://github.com/dmno-dev/varlock/commit/bb1c0755dc826a7322ecbbfa26c01c1b99f2bcb1)]:
  - varlock@0.6.3

## 0.2.6

### Patch Changes

- Updated dependencies [[`7b31afe`](https://github.com/dmno-dev/varlock/commit/7b31afecf9b571452be87c86f9ef54731235c06e), [`dbf0bd4`](https://github.com/dmno-dev/varlock/commit/dbf0bd4fb46918cafb7b72cb0cfd4bbc9132b3d3), [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac), [`1e8bca6`](https://github.com/dmno-dev/varlock/commit/1e8bca69b0f455ed58390545a1f9cbfb90d92131), [`ab417d7`](https://github.com/dmno-dev/varlock/commit/ab417d772ed06d671060a16273f33c1503e44333), [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4)]:
  - varlock@0.6.0

## 0.2.5

### Patch Changes

- [#402](https://github.com/dmno-dev/varlock/pull/402) [`f1873ec`](https://github.com/dmno-dev/varlock/commit/f1873ec56834122b323b1ef27c7715250433a0dc) - Fix ENV.\* static replacement being skipped for Vite dev module IDs with query suffixes (e.g. `?tsr-split=component` from TanStack Router split routes). The file extension is now extracted from the path portion of the ID only, ignoring any query string or hash fragment.

- Updated dependencies [[`4d436ff`](https://github.com/dmno-dev/varlock/commit/4d436ff42863136fb5ebb7016e525ef54732ea20), [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa)]:
  - varlock@0.5.0

## 0.2.4

### Patch Changes

- [#397](https://github.com/dmno-dev/varlock/pull/397) [`b62a7f7`](https://github.com/dmno-dev/varlock/commit/b62a7f71ba348abdb35677a6840f2d092c351b7f) - add file type guard on varlock injection

- Updated dependencies [[`5890ee6`](https://github.com/dmno-dev/varlock/commit/5890ee6864930ac4561589d86c87e749733e3755), [`0642185`](https://github.com/dmno-dev/varlock/commit/06421851813e838ea38a4730ab5dec55d8b625ed), [`64c8ba9`](https://github.com/dmno-dev/varlock/commit/64c8ba98be7f5616ac556b8e4bd6a66bd73767d4)]:
  - varlock@0.4.2

## 0.2.3

### Patch Changes

- Updated dependencies [[`e30ec1f`](https://github.com/dmno-dev/varlock/commit/e30ec1f6c193365903c734f9443dea0ae420c9bb)]:
  - varlock@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`1a42d3f`](https://github.com/dmno-dev/varlock/commit/1a42d3f88c89a136f3745a1586e9b43bc9b7b069), [`6b64a4f`](https://github.com/dmno-dev/varlock/commit/6b64a4fce63e951d116b2ad5df3027906e9b9f8f), [`98fccd6`](https://github.com/dmno-dev/varlock/commit/98fccd6c2ce48897bbe3db1aad9191171c4a84f2), [`9d8302f`](https://github.com/dmno-dev/varlock/commit/9d8302f2397abef7b49a62d1700f1339be8aa8d9), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39), [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206), [`ccff56b`](https://github.com/dmno-dev/varlock/commit/ccff56b6fba018c3e30d3f91261a4a03c1548c6d), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39)]:
  - varlock@0.3.0

## 0.2.1

### Patch Changes

- [#299](https://github.com/dmno-dev/varlock/pull/299) [`9eb37b2`](https://github.com/dmno-dev/varlock/commit/9eb37b232b0054078ac26525d6a84f384d16aed8) - ripped out some deps, minor cleanup

- Updated dependencies [[`a4bb4e9`](https://github.com/dmno-dev/varlock/commit/a4bb4e9e2ef8e604b99e39a0425806ceb8b60188), [`9eb37b2`](https://github.com/dmno-dev/varlock/commit/9eb37b232b0054078ac26525d6a84f384d16aed8)]:
  - varlock@0.2.3

## 0.2.0

### Patch Changes

- Updated dependencies [[`c872e71`](https://github.com/dmno-dev/varlock/commit/c872e7169b71d73043104ca9e345a03accc24650), [`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d), [`15b9c81`](https://github.com/dmno-dev/varlock/commit/15b9c81ac4941c4dbefb38812d0701274f4b4dad), [`e5c7d24`](https://github.com/dmno-dev/varlock/commit/e5c7d24b59c6dd01780bf655cb0edb616d38c301), [`bcba478`](https://github.com/dmno-dev/varlock/commit/bcba4788ca35f58c4c54266aba728c0d603617d2), [`558360a`](https://github.com/dmno-dev/varlock/commit/558360a99b72fd5a5a875e71cc6772ec13ffd936), [`50c4ad4`](https://github.com/dmno-dev/varlock/commit/50c4ad426d4e5fc90f9bee02c6b4c683433a733c), [`c0d9942`](https://github.com/dmno-dev/varlock/commit/c0d994297289206c6f9516151a313b0a429dc454)]:
  - varlock@0.2.0

## 0.1.1

### Patch Changes

- [#221](https://github.com/dmno-dev/varlock/pull/221) [`8d2d284`](https://github.com/dmno-dev/varlock/commit/8d2d284d002307ae7f687681f33efc0827d02316) - fix for local dev with cloudflare+vite

## 1.0.0

### Patch Changes

- Updated dependencies [[`8bae875`](https://github.com/dmno-dev/varlock/commit/8bae875503c5f9a9d84bc772ad41be1fb3e4febd), [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8)]:
  - varlock@0.1.0

## 0.0.11

### Patch Changes

- [#163](https://github.com/dmno-dev/varlock/pull/163) [`8d31513`](https://github.com/dmno-dev/varlock/commit/8d315132de5d2b40f4c6423d10747cbc848d3392) - fix issue with executable path when running directly instead of via package manager

- Updated dependencies [[`b6fc6dd`](https://github.com/dmno-dev/varlock/commit/b6fc6dd396b87b02c1e7e72d6fe84b493c29776f), [`8d31513`](https://github.com/dmno-dev/varlock/commit/8d315132de5d2b40f4c6423d10747cbc848d3392)]:
  - varlock@0.0.15

## 0.0.10

### Patch Changes

- Updated dependencies [[`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd), [`999016c`](https://github.com/dmno-dev/varlock/commit/999016c0ec6bd83aa4ee3975d93a553beba4be3d), [`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd), [`9025edc`](https://github.com/dmno-dev/varlock/commit/9025edcdc0e60d0ac587cbae7b5fc28fd7b7b5e6)]:
  - varlock@0.0.14

## 0.0.9

### Patch Changes

- Updated dependencies [[`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f)]:
  - varlock@0.0.13

## 0.0.8

### Patch Changes

- Updated dependencies [[`0d00628`](https://github.com/dmno-dev/varlock/commit/0d00628cf3ecc33211abc18f40636233a7141928), [`89d4255`](https://github.com/dmno-dev/varlock/commit/89d4255d7e32dffe660d486a18ca5ddb1b2ceb88), [`851aaf0`](https://github.com/dmno-dev/varlock/commit/851aaf0e4f575882e97079c8fdfe6c1a2dba5c08)]:
  - varlock@0.0.12

## 0.0.7

### Patch Changes

- [#132](https://github.com/dmno-dev/varlock/pull/132) [`330bd92`](https://github.com/dmno-dev/varlock/commit/330bd921bbbae0b64a7c98e321711d6e87c49843) - fix logic around setting process.env and handling empty/undefined vals

- Updated dependencies [[`330bd92`](https://github.com/dmno-dev/varlock/commit/330bd921bbbae0b64a7c98e321711d6e87c49843)]:
  - varlock@0.0.11

## 0.0.6

### Patch Changes

- Updated dependencies [[`17206e8`](https://github.com/dmno-dev/varlock/commit/17206e86e10ca178ce2e6115ecf1d42b4e8dce7e)]:
  - varlock@0.0.10

## 0.0.5

### Patch Changes

- [#116](https://github.com/dmno-dev/varlock/pull/116) [`9e8b40a`](https://github.com/dmno-dev/varlock/commit/9e8b40a04360dc78c82d29da261f378a0d2d92f5) - - make Vite plugin work for SSR scenarios, injecting code and resolved env (in some cases)
  - detect Cloudflare Vite plugin
  - make compatible with React Router 7
  - simplify astro integration to rely on vite integration more
- Updated dependencies [[`9e8b40a`](https://github.com/dmno-dev/varlock/commit/9e8b40a04360dc78c82d29da261f378a0d2d92f5), [`86c02bf`](https://github.com/dmno-dev/varlock/commit/86c02bf7f5283c487c576e884699f94863b4773e)]:
  - varlock@0.0.9

## 0.0.4

### Patch Changes

- [#111](https://github.com/dmno-dev/varlock/pull/111) [`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4) - update deps

- Updated dependencies [[`f4ed06e`](https://github.com/dmno-dev/varlock/commit/f4ed06eb62c7aa0bc858e0e710e620bd330604fa), [`1bc2650`](https://github.com/dmno-dev/varlock/commit/1bc26508760c8dd4940393f40e94b00d9a2f2688), [`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4)]:
  - varlock@0.0.8

## 0.0.3

### Patch Changes

- [#101](https://github.com/dmno-dev/varlock/pull/101) [`48d1c4d`](https://github.com/dmno-dev/varlock/commit/48d1c4d76eb40e0b44321fc5ff7073daa4707702) - new astro integration, based on vite integration

- [#103](https://github.com/dmno-dev/varlock/pull/103) [`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f) - chore: update dependencies

- Updated dependencies [[`48d1c4d`](https://github.com/dmno-dev/varlock/commit/48d1c4d76eb40e0b44321fc5ff7073daa4707702), [`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f)]:
  - varlock@0.0.7

## 0.0.2

### Patch Changes

- [#91](https://github.com/dmno-dev/varlock/pull/91) [`186d6ed`](https://github.com/dmno-dev/varlock/commit/186d6ed2fdf0ace184510b99c222d15a1c1d83a9) - fix vite reloading logic

- [#91](https://github.com/dmno-dev/varlock/pull/91) [`186d6ed`](https://github.com/dmno-dev/varlock/commit/186d6ed2fdf0ace184510b99c222d15a1c1d83a9) - use ast-based replacement method instead of naive string replacement

- Updated dependencies [[`186d6ed`](https://github.com/dmno-dev/varlock/commit/186d6ed2fdf0ace184510b99c222d15a1c1d83a9)]:
  - varlock@0.0.6

## 0.0.1

### Patch Changes

- [#77](https://github.com/dmno-dev/varlock/pull/77) [`f49fd2a`](https://github.com/dmno-dev/varlock/commit/f49fd2a2c07f8fc58654d4a1c1bac9fd9ba7df3e) - vite integration

- Updated dependencies [[`7407999`](https://github.com/dmno-dev/varlock/commit/7407999d58394fe5ce6e5f9667cd1a540d9e4951), [`f49fd2a`](https://github.com/dmno-dev/varlock/commit/f49fd2a2c07f8fc58654d4a1c1bac9fd9ba7df3e), [`33874e8`](https://github.com/dmno-dev/varlock/commit/33874e863227759b299b1745158018fe2393a142)]:
  - varlock@0.0.5
