# @varlock/google-secret-manager-plugin

## 0.2.0

### Minor Changes

- [#435](https://github.com/dmno-dev/varlock/pull/435) [`798ed99`](https://github.com/dmno-dev/varlock/commit/798ed997fd5682f01f76ff9f264202454d7f6003) - fix: replace gRPC-based `@google-cloud/secret-manager` client with REST API + `google-auth-library` to fix ADC (Application Default Credentials) auth failures in Bun

### Patch Changes

- [#436](https://github.com/dmno-dev/varlock/pull/436) [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac) - fix: switch plugins to CJS output to fix plugin loading errors in the standalone binary

  Previously plugins were built as ESM and the loader performed a fragile regex-based ESM→CJS transformation. Plugins now build as CJS directly and are loaded via `new Function` in the main runtime context, which avoids both the ESM parse errors and Node.js internal assertion failures (e.g. `DOMException` lazy getter crashing in vm sandbox contexts).

- [#415](https://github.com/dmno-dev/varlock/pull/415) [`29316c5`](https://github.com/dmno-dev/varlock/commit/29316c5703f0bad7780c3af024bfa8b496eac68b) - fix: use `fileURLToPath` instead of `.pathname` to derive `__dirname` in plugin ESM banner, preventing doubled drive letters (`C:\C:\...`) on Windows

- [#438](https://github.com/dmno-dev/varlock/pull/438) [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4) - general cleanup and standardization of plugins

  feat: add `standardVars` plugin property for automatic env var detection warnings

  Plugins can now declaratively set `plugin.standardVars` to define well-known env vars they use. The loading infrastructure automatically checks for these vars in the environment and shows non-blocking warnings (in pretty output or on failure) when they are detected but not wired into the schema or plugin decorator. Green highlighting indicates items that need to be added.

- Updated dependencies [[`7b31afe`](https://github.com/dmno-dev/varlock/commit/7b31afecf9b571452be87c86f9ef54731235c06e), [`dbf0bd4`](https://github.com/dmno-dev/varlock/commit/dbf0bd4fb46918cafb7b72cb0cfd4bbc9132b3d3), [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac), [`1e8bca6`](https://github.com/dmno-dev/varlock/commit/1e8bca69b0f455ed58390545a1f9cbfb90d92131), [`ab417d7`](https://github.com/dmno-dev/varlock/commit/ab417d772ed06d671060a16273f33c1503e44333), [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4)]:
  - varlock@0.6.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`4d436ff`](https://github.com/dmno-dev/varlock/commit/4d436ff42863136fb5ebb7016e525ef54732ea20), [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa)]:
  - varlock@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`e30ec1f`](https://github.com/dmno-dev/varlock/commit/e30ec1f6c193365903c734f9443dea0ae420c9bb)]:
  - varlock@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`1a42d3f`](https://github.com/dmno-dev/varlock/commit/1a42d3f88c89a136f3745a1586e9b43bc9b7b069), [`6b64a4f`](https://github.com/dmno-dev/varlock/commit/6b64a4fce63e951d116b2ad5df3027906e9b9f8f), [`98fccd6`](https://github.com/dmno-dev/varlock/commit/98fccd6c2ce48897bbe3db1aad9191171c4a84f2), [`9d8302f`](https://github.com/dmno-dev/varlock/commit/9d8302f2397abef7b49a62d1700f1339be8aa8d9), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39), [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206), [`ccff56b`](https://github.com/dmno-dev/varlock/commit/ccff56b6fba018c3e30d3f91261a4a03c1548c6d), [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39)]:
  - varlock@0.3.0

## 0.1.1

### Patch Changes

- [#295](https://github.com/dmno-dev/varlock/pull/295) [`6374308`](https://github.com/dmno-dev/varlock/commit/63743089955d9bd3dd7805ac895bd4545a197e4f) - update gcp lib, remove punylib deprecation, infer keyname if not set

- Updated dependencies [[`87b470d`](https://github.com/dmno-dev/varlock/commit/87b470dec31392f49a1f23032857b2d777978521)]:
  - varlock@0.2.2

## 0.1.0

### Patch Changes

- Updated dependencies [[`c872e71`](https://github.com/dmno-dev/varlock/commit/c872e7169b71d73043104ca9e345a03accc24650), [`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d), [`15b9c81`](https://github.com/dmno-dev/varlock/commit/15b9c81ac4941c4dbefb38812d0701274f4b4dad), [`e5c7d24`](https://github.com/dmno-dev/varlock/commit/e5c7d24b59c6dd01780bf655cb0edb616d38c301), [`bcba478`](https://github.com/dmno-dev/varlock/commit/bcba4788ca35f58c4c54266aba728c0d603617d2), [`558360a`](https://github.com/dmno-dev/varlock/commit/558360a99b72fd5a5a875e71cc6772ec13ffd936), [`50c4ad4`](https://github.com/dmno-dev/varlock/commit/50c4ad426d4e5fc90f9bee02c6b4c683433a733c), [`c0d9942`](https://github.com/dmno-dev/varlock/commit/c0d994297289206c6f9516151a313b0a429dc454)]:
  - varlock@0.2.0

## 0.0.2

### Patch Changes

- [#248](https://github.com/dmno-dev/varlock/pull/248) [`fee9f21`](https://github.com/dmno-dev/varlock/commit/fee9f2158f800987a6bedde8d1ca473919c43901) Thanks [@ya7010](https://github.com/ya7010)! - feat: support dynamic projectId on google-secret-manager plugin.

- Updated dependencies [[`2c91174`](https://github.com/dmno-dev/varlock/commit/2c91174404be57208a5a865ed9335f8985a3e11e)]:
  - varlock@0.1.5

## 0.0.1

### Patch Changes

- [#237](https://github.com/dmno-dev/varlock/pull/237) [`efec365`](https://github.com/dmno-dev/varlock/commit/efec365db2413871df719440b19e52195485589c) Thanks [@ya7010](https://github.com/ya7010)! - initial version of Google Secret Manager plugin
