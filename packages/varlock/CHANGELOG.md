# varlock

## 0.6.2

### Patch Changes

- [#450](https://github.com/dmno-dev/varlock/pull/450) [`40b65e8`](https://github.com/dmno-dev/varlock/commit/40b65e82578d358917b916c9bc1436849d0400a8) - fix: warning-level schema errors no longer block plugin loading or item resolution

  Warning errors (e.g., deprecated syntax warnings) were incorrectly treated as hard errors in several places, causing early bail-outs that prevented plugins from loading and items from resolving. Fixed `isValid`, `finishLoad`, and decorator `resolve` checks to filter out warnings.

## 0.6.1

### Patch Changes

- [#445](https://github.com/dmno-dev/varlock/pull/445) [`57f0e04`](https://github.com/dmno-dev/varlock/commit/57f0e04e1f86b22f08a3a3a0a1bce29b7f38d1fc) - update bun to v1.3.11 - publish new binaries

## 0.6.0

### Minor Changes

- [#436](https://github.com/dmno-dev/varlock/pull/436) [`eaf6c10`](https://github.com/dmno-dev/varlock/commit/eaf6c104259899df6fa4128cfe569f7ef3e9acac) - fix: switch plugins to CJS output to fix plugin loading errors in the standalone binary

  Previously plugins were built as ESM and the loader performed a fragile regex-based ESM→CJS transformation. Plugins now build as CJS directly and are loaded via `new Function` in the main runtime context, which avoids both the ESM parse errors and Node.js internal assertion failures (e.g. `DOMException` lazy getter crashing in vm sandbox contexts).

- [#438](https://github.com/dmno-dev/varlock/pull/438) [`b540985`](https://github.com/dmno-dev/varlock/commit/b5409857a74874bbcd8850251a38e51ddcb8e6a4) - general cleanup and standardization of plugins

  feat: add `standardVars` plugin property for automatic env var detection warnings

  Plugins can now declaratively set `plugin.standardVars` to define well-known env vars they use. The loading infrastructure automatically checks for these vars in the environment and shows non-blocking warnings (in pretty output or on failure) when they are detected but not wired into the schema or plugin decorator. Green highlighting indicates items that need to be added.

### Patch Changes

- [#421](https://github.com/dmno-dev/varlock/pull/421) [`7b31afe`](https://github.com/dmno-dev/varlock/commit/7b31afecf9b571452be87c86f9ef54731235c06e) - feat: add `ifs()` function and update `remap()` to support positional arg pairs

  - **New `ifs()` function**: Excel-style conditional that evaluates condition/value pairs and returns the value for the first truthy condition. An optional trailing default value is used when no condition matches.

    ```env-spec
    API_URL=ifs(
      eq($ENV, production), https://api.example.com,
      eq($ENV, staging), https://staging-api.example.com,
      http://localhost:3000
    )
    ```

  - **Updated `remap()` function**: Now supports positional `(match, result)` pairs as the preferred syntax. The old key=value syntax (`result=match`) is still supported but deprecated.

    ```env-spec
    # new preferred syntax (match first, result second)
    APP_ENV=remap($CI_BRANCH, "main", production, regex(.*), preview, undefined, development)

    # old syntax (still works but deprecated)
    APP_ENV=remap($CI_BRANCH, production="main", preview=regex(.*), development=undefined)
    ```

- [#429](https://github.com/dmno-dev/varlock/pull/429) [`dbf0bd4`](https://github.com/dmno-dev/varlock/commit/dbf0bd4fb46918cafb7b72cb0cfd4bbc9132b3d3) - fix: defer plugin auth errors until resolver is actually used, and prefix resolution errors with resolver function name for clearer error messages

- [#393](https://github.com/dmno-dev/varlock/pull/393) [`1e8bca6`](https://github.com/dmno-dev/varlock/commit/1e8bca69b0f455ed58390545a1f9cbfb90d92131) - turbopack support

- [#431](https://github.com/dmno-dev/varlock/pull/431) [`ab417d7`](https://github.com/dmno-dev/varlock/commit/ab417d772ed06d671060a16273f33c1503e44333) - Fix: Exclude `.env.local` files and their imports from generated TypeScript types.

## 0.5.0

### Minor Changes

- [#406](https://github.com/dmno-dev/varlock/pull/406) [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa) - Relax header divider requirement - the header block no longer requires a trailing `# ---` divider. All comment blocks before the first config item are now treated as part of the header. Add validation errors for misplaced decorators: item decorators in the header, root decorators on config items, and decorators in detached comment blocks.

### Patch Changes

- [#398](https://github.com/dmno-dev/varlock/pull/398) [`4d436ff`](https://github.com/dmno-dev/varlock/commit/4d436ff42863136fb5ebb7016e525ef54732ea20) - fix: convert plugin file paths to `file://` URLs before dynamic `import()` to resolve `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows

## 0.4.2

### Patch Changes

- [#385](https://github.com/dmno-dev/varlock/pull/385) [`5890ee6`](https://github.com/dmno-dev/varlock/commit/5890ee6864930ac4561589d86c87e749733e3755) - fix: `patchGlobalResponse` broke `fetch()` responses failing `instanceof Response` checks. After patching `globalThis.Response` with `VarlockPatchedResponse`, native `fetch()` still returned the original `Response` instances, causing SvelteKit SSR endpoints to throw "handler should return a Response object". Added `Symbol.hasInstance` to `VarlockPatchedResponse` so native responses pass the check.

- [#384](https://github.com/dmno-dev/varlock/pull/384) [`0642185`](https://github.com/dmno-dev/varlock/commit/06421851813e838ea38a4730ab5dec55d8b625ed) - Fix telemetry disable command showing incorrect success message

- [#387](https://github.com/dmno-dev/varlock/pull/387) [`64c8ba9`](https://github.com/dmno-dev/varlock/commit/64c8ba98be7f5616ac556b8e4bd6a66bd73767d4) - fix: auto trigger type generation in `varlock run` (unless auto=false flag is used)

## 0.4.1

### Patch Changes

- [#358](https://github.com/dmno-dev/varlock/pull/358) [`c7e2d7a`](https://github.com/dmno-dev/varlock/commit/c7e2d7a752e53a1bbb30fddf4fb88e7834d47be3) - Add `shell` output format to `varlock load` command. `--format shell` outputs `export KEY=VALUE` lines suitable for `eval` or sourcing into the current shell session, enabling easy integration with tools like [direnv](https://direnv.net/).

- [#371](https://github.com/dmno-dev/varlock/pull/371) [`1b9797e`](https://github.com/dmno-dev/varlock/commit/1b9797ed339b6b9955d5356da4f29517d23dfea3) - Fix dynamic `@required` being incorrectly resolved after type generation runs.

  When `generateTypesIfNeeded()` ran before `resolveEnvValues()` (as it does in the CLI), `getTypeGenInfo()` would call `resolve()` on dynamic decorators like `@required=eq($OTHER, foo)` before their dependencies were resolved. This cached a stale result on the decorator, causing `processRequired()` to return the wrong value when env values were later resolved.

  The fix skips calling `resolve()` for dynamic decorators in `getTypeGenInfo()` — their runtime value is irrelevant for type generation anyway (dynamic required items are always typed as optional).

- [#364](https://github.com/dmno-dev/varlock/pull/364) [`78307f9`](https://github.com/dmno-dev/varlock/commit/78307f987dbc25a3c0565b6739802e9f06a8305a) - fix: `varlock printenv MY_VAR` was failing with `Variable "printenv" not found in schema` because gunshi includes the subcommand name in `ctx.positionals`. Now correctly slices past the subcommand path to extract the variable name.

- [#356](https://github.com/dmno-dev/varlock/pull/356) [`61e2094`](https://github.com/dmno-dev/varlock/commit/61e2094f28ab9d6abcc9aefebfdd267a88dea2b2) - Add `enabled` option to `@setValuesBulk` decorator, allowing conditional bulk value injection based on boolean expressions (including dynamic expressions referencing other config items).

- [#352](https://github.com/dmno-dev/varlock/pull/352) [`0e4d39a`](https://github.com/dmno-dev/varlock/commit/0e4d39acba3707cfb30f534ed47161e64b805a00) - Support XDG Base Directory Specification for user config directory. Varlock now respects `$XDG_CONFIG_HOME` and defaults to `~/.config/varlock` instead of `~/.varlock` for new installations, while maintaining backwards compatibility with existing `~/.varlock` directories.

## 0.4.0

### Minor Changes

- [#342](https://github.com/dmno-dev/varlock/pull/342) [`e30ec1f`](https://github.com/dmno-dev/varlock/commit/e30ec1f6c193365903c734f9443dea0ae420c9bb) - Environment-independent type generation

  - Type generation now runs before env value resolution, producing deterministic TypeScript types regardless of which environment is active
  - Added `isEnvSpecific` tracking on data sources to identify environment-dependent files (`.env.production`, conditional `@disable`, conditional `@import`)
  - Items defined only in env-specific files are excluded from generated types
  - Added `auto=false` parameter to `@generateTypes` decorator to disable automatic type generation during `varlock load` and `varlock run`
  - Added `varlock typegen` command for manual type generation

## 0.3.0

### Minor Changes

- [#316](https://github.com/dmno-dev/varlock/pull/316) [`9d8302f`](https://github.com/dmno-dev/varlock/commit/9d8302f2397abef7b49a62d1700f1339be8aa8d9) - Add `varlock scan` command to detect leaked secrets in project files, with `--install-hook` flag to set up a git pre-commit hook. Automatically detects package manager (npm, pnpm, bun, etc.) and hook managers (husky, lefthook, simple-git-hooks) for correct setup.

- [#313](https://github.com/dmno-dev/varlock/pull/313) [`ccff56b`](https://github.com/dmno-dev/varlock/commit/ccff56b6fba018c3e30d3f91261a4a03c1548c6d) - migrate to bun as package manager and for SEA

### Patch Changes

- [#314](https://github.com/dmno-dev/varlock/pull/314) [`1a42d3f`](https://github.com/dmno-dev/varlock/commit/1a42d3f88c89a136f3745a1586e9b43bc9b7b069) - add `varlock printenv` command to print a single env value

- [#319](https://github.com/dmno-dev/varlock/pull/319) [`6b64a4f`](https://github.com/dmno-dev/varlock/commit/6b64a4fce63e951d116b2ad5df3027906e9b9f8f) - add bunfig setup to varlock init for bun projects

- [#254](https://github.com/dmno-dev/varlock/pull/254) [`98fccd6`](https://github.com/dmno-dev/varlock/commit/98fccd6c2ce48897bbe3db1aad9191171c4a84f2) - Fix assertion failure on Windows when varlock cli exits

- [#307](https://github.com/dmno-dev/varlock/pull/307) [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39) - new @setValuesBulk root decorator

- [#285](https://github.com/dmno-dev/varlock/pull/285) [`2d15354`](https://github.com/dmno-dev/varlock/commit/2d153547a08cc9b23e85d6e66a4b557222c9c206) - new auto-inferred VARLOCK_ENV from ci info (uses new ci-env-info package)

- [#307](https://github.com/dmno-dev/varlock/pull/307) [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39) - add 1password environments loader, improve how resolver errors are shown to the user

## 0.2.3

### Patch Changes

- [#309](https://github.com/dmno-dev/varlock/pull/309) [`a4bb4e9`](https://github.com/dmno-dev/varlock/commit/a4bb4e9e2ef8e604b99e39a0425806ceb8b60188) - disable project level anonymous id check

- [#299](https://github.com/dmno-dev/varlock/pull/299) [`9eb37b2`](https://github.com/dmno-dev/varlock/commit/9eb37b232b0054078ac26525d6a84f384d16aed8) - ripped out some deps, minor cleanup

## 0.2.2

### Patch Changes

- [#297](https://github.com/dmno-dev/varlock/pull/297) [`87b470d`](https://github.com/dmno-dev/varlock/commit/87b470dec31392f49a1f23032857b2d777978521) - fix how errors are exposed when plugin loading fails

## 0.2.1

### Patch Changes

- [#283](https://github.com/dmno-dev/varlock/pull/283) [`95f9274`](https://github.com/dmno-dev/varlock/commit/95f9274a3179321656f6e6bd4248922745b64f16) - Add `--path` / `-p` flag to `load` and `run` commands to specify a .env file or directory as the entry point

## 0.2.0

### Minor Changes

- [#278](https://github.com/dmno-dev/varlock/pull/278) [`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d) - allow multi-line fn calls, both in decorator and item values

- [#273](https://github.com/dmno-dev/varlock/pull/273) [`15b9c81`](https://github.com/dmno-dev/varlock/commit/15b9c81ac4941c4dbefb38812d0701274f4b4dad) - Add conditional `@import` with named `enabled` parameter

### Patch Changes

- [#274](https://github.com/dmno-dev/varlock/pull/274) [`c872e71`](https://github.com/dmno-dev/varlock/commit/c872e7169b71d73043104ca9e345a03accc24650) - Add `@public` item decorator as the counterpart to `@sensitive`, matching the pattern of `@required`/`@optional` decorator pairs

- [#262](https://github.com/dmno-dev/varlock/pull/262) [`e5c7d24`](https://github.com/dmno-dev/varlock/commit/e5c7d24b59c6dd01780bf655cb0edb616d38c301) Thanks [@ya7010](https://github.com/ya7010)! - feat: add `--compact` flag `varlock load`.

- [#271](https://github.com/dmno-dev/varlock/pull/271) [`bcba478`](https://github.com/dmno-dev/varlock/commit/bcba4788ca35f58c4c54266aba728c0d603617d2) - Improve CLI help text for all commands by adding detailed examples and usage guidance. Each command now includes comprehensive help information with usage examples, tips, and links to documentation.

- [#270](https://github.com/dmno-dev/varlock/pull/270) [`558360a`](https://github.com/dmno-dev/varlock/commit/558360a99b72fd5a5a875e71cc6772ec13ffd936) - - allow importing from ~

  - remove git ignore checks as part of core loading logic, we can re-add in specific commands where necessary

- [#281](https://github.com/dmno-dev/varlock/pull/281) [`50c4ad4`](https://github.com/dmno-dev/varlock/commit/50c4ad426d4e5fc90f9bee02c6b4c683433a733c) - Add allowMissing flag to @import decorator

- [#275](https://github.com/dmno-dev/varlock/pull/275) [`c0d9942`](https://github.com/dmno-dev/varlock/commit/c0d994297289206c6f9516151a313b0a429dc454) - Fix package manager detection to handle multiple lockfiles gracefully. When multiple lockfiles are found (e.g., both package-lock.json and bun.lockb), the detection now:
  1. First tries env var based detection (npm_config_user_agent) to respect the currently active package manager
  2. If that fails, returns the first detected package manager as a fallback
  3. No longer throws an error, preventing CLI crashes in monorepos or when switching package managers
- Updated dependencies [[`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d)]:
  - @env-spec/parser@0.1.0

## 0.1.6

### Patch Changes

- [#268](https://github.com/dmno-dev/varlock/pull/268) [`d4b6b3d`](https://github.com/dmno-dev/varlock/commit/d4b6b3de52ba81e0a8d97339c27d70f0361d7f6a) - add --no-redact-stdout flag to varlock run

## 0.1.5

### Patch Changes

- [#252](https://github.com/dmno-dev/varlock/pull/252) [`2c91174`](https://github.com/dmno-dev/varlock/commit/2c91174404be57208a5a865ed9335f8985a3e11e) - apply redaction to stdout and sterr in `varlock run`

## 0.1.4

### Patch Changes

- [#245](https://github.com/dmno-dev/varlock/pull/245) [`901fada`](https://github.com/dmno-dev/varlock/commit/901fada4e2aa2cc93dbd13441bdff37ab0896e2d) - disable `@generateTypes` in imported files

## 0.1.3

### Patch Changes

- [#216](https://github.com/dmno-dev/varlock/pull/216) [`23ed768`](https://github.com/dmno-dev/varlock/commit/23ed76867f673ec1d7bf420632be1d902678becc) - fix runtime env code to not assume process (or shim) exists - for sveltekit

- Updated dependencies [[`82a7340`](https://github.com/dmno-dev/varlock/commit/82a7340a695d62a40c908c37432c6d9cfd7e2c3d)]:
  - @env-spec/parser@0.0.8

## 0.1.2

### Patch Changes

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) - allow if() to take 1 arg to coerce to boolean

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) - allow @required/@sensitive to accept undefined

- [#204](https://github.com/dmno-dev/varlock/pull/204) [`6f4e998`](https://github.com/dmno-dev/varlock/commit/6f4e9984bd5bb398b4fabd5d20a1283e41e66dd4) - fix logic around finding the varlock executable to work with windows .cmd files

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) - make ENV readonly without making process.env readonly

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) - adjust loading behavior for browser testing (vitest jsdom)

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) - add not() and isEmpty() resolvers

## 0.1.1

### Patch Changes

- [#200](https://github.com/dmno-dev/varlock/pull/200) [`f98a63f`](https://github.com/dmno-dev/varlock/commit/f98a63fdb68f461bf02bc1797a406f45f5afd875) - add project-level config file

- [#201](https://github.com/dmno-dev/varlock/pull/201) [`e65e1c9`](https://github.com/dmno-dev/varlock/commit/e65e1c97b98d5d24ef84fc72c01c52a19e36ea01) - use process.cwd() instead of process.env.PWD

## 0.1.0

### Minor Changes

- [#168](https://github.com/dmno-dev/varlock/pull/168) [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8) - unify resolvers with decorators, new plugin system, 1pass plugin

### Patch Changes

- [#186](https://github.com/dmno-dev/varlock/pull/186) [`8bae875`](https://github.com/dmno-dev/varlock/commit/8bae875503c5f9a9d84bc772ad41be1fb3e4febd) - dep updates

- Updated dependencies [[`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8)]:
  - @env-spec/parser@0.0.7

## 0.0.15

### Patch Changes

- [#162](https://github.com/dmno-dev/varlock/pull/162) [`b6fc6dd`](https://github.com/dmno-dev/varlock/commit/b6fc6dd396b87b02c1e7e72d6fe84b493c29776f) - fix import relative path issues

- [#163](https://github.com/dmno-dev/varlock/pull/163) [`8d31513`](https://github.com/dmno-dev/varlock/commit/8d315132de5d2b40f4c6423d10747cbc848d3392) - fix issue with executable path when running directly instead of via package manager

## 0.0.14

### Patch Changes

- [#157](https://github.com/dmno-dev/varlock/pull/157) [`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd) - adjust server response leak detection for no content type

- [#158](https://github.com/dmno-dev/varlock/pull/158) [`999016c`](https://github.com/dmno-dev/varlock/commit/999016c0ec6bd83aa4ee3975d93a553beba4be3d) - allow setting envFlag from an imported file

- [#157](https://github.com/dmno-dev/varlock/pull/157) [`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd) - set defaultRequired to infer during varlock init

- [#160](https://github.com/dmno-dev/varlock/pull/160) [`9025edc`](https://github.com/dmno-dev/varlock/commit/9025edcdc0e60d0ac587cbae7b5fc28fd7b7b5e6) - fix URL data type validation error mesage

- Updated dependencies [[`7b3e2f4`](https://github.com/dmno-dev/varlock/commit/7b3e2f4fb50dfd81ea1e1ba1a9298fd6be53ea6f)]:
  - @env-spec/parser@0.0.6

## 0.0.13

### Patch Changes

- [#147](https://github.com/dmno-dev/varlock/pull/147) [`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f) - new @import decorator

- Updated dependencies [[`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f)]:
  - @env-spec/parser@0.0.5

## 0.0.12

### Patch Changes

- [#125](https://github.com/dmno-dev/varlock/pull/125) [`0d00628`](https://github.com/dmno-dev/varlock/commit/0d00628cf3ecc33211abc18f40636233a7141928) - restrict @envFlag to being used in .env.schema

- [#138](https://github.com/dmno-dev/varlock/pull/138) [`89d4255`](https://github.com/dmno-dev/varlock/commit/89d4255d7e32dffe660d486a18ca5ddb1b2ceb88) - remove envFlag normalization

- [#136](https://github.com/dmno-dev/varlock/pull/136) [`851aaf0`](https://github.com/dmno-dev/varlock/commit/851aaf0e4f575882e97079c8fdfe6c1a2dba5c08) - add new `forEnv()` helper for @required decorator, to allow dynamically setting required-ness based on current env flag

## 0.0.11

### Patch Changes

- [#132](https://github.com/dmno-dev/varlock/pull/132) [`330bd92`](https://github.com/dmno-dev/varlock/commit/330bd921bbbae0b64a7c98e321711d6e87c49843) - fix logic around setting process.env and handling empty/undefined vals

## 0.0.10

### Patch Changes

- [#130](https://github.com/dmno-dev/varlock/pull/130) [`17206e8`](https://github.com/dmno-dev/varlock/commit/17206e86e10ca178ce2e6115ecf1d42b4e8dce7e) - fix for astro+vite plugin

## 0.0.9

### Patch Changes

- [#116](https://github.com/dmno-dev/varlock/pull/116) [`9e8b40a`](https://github.com/dmno-dev/varlock/commit/9e8b40a04360dc78c82d29da261f378a0d2d92f5) - fix bug with global Response patching (for cloudflare)

- [#114](https://github.com/dmno-dev/varlock/pull/114) [`86c02bf`](https://github.com/dmno-dev/varlock/commit/86c02bf7f5283c487c576e884699f94863b4773e) - Fixed git not installed error

## 0.0.8

### Patch Changes

- [#98](https://github.com/dmno-dev/varlock/pull/98) [`f4ed06e`](https://github.com/dmno-dev/varlock/commit/f4ed06eb62c7aa0bc858e0e710e620bd330604fa) - add internal export

- [#109](https://github.com/dmno-dev/varlock/pull/109) [`1bc2650`](https://github.com/dmno-dev/varlock/commit/1bc26508760c8dd4940393f40e94b00d9a2f2688) - ignore .envrc files - only .env and .env.\* will be loaded

- [#111](https://github.com/dmno-dev/varlock/pull/111) [`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4) - update deps

- Updated dependencies [[`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4)]:
  - @env-spec/parser@0.0.4

## 0.0.7

### Patch Changes

- [#101](https://github.com/dmno-dev/varlock/pull/101) [`48d1c4d`](https://github.com/dmno-dev/varlock/commit/48d1c4d76eb40e0b44321fc5ff7073daa4707702) - new astro integration, based on vite integration

- [#103](https://github.com/dmno-dev/varlock/pull/103) [`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f) - chore: update dependencies

- Updated dependencies [[`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f)]:
  - @env-spec/parser@0.0.3

## 0.0.6

### Patch Changes

- [#91](https://github.com/dmno-dev/varlock/pull/91) [`186d6ed`](https://github.com/dmno-dev/varlock/commit/186d6ed2fdf0ace184510b99c222d15a1c1d83a9) - init bugfixes

## 0.0.5

### Patch Changes

- [#84](https://github.com/dmno-dev/varlock/pull/84) [`7407999`](https://github.com/dmno-dev/varlock/commit/7407999d58394fe5ce6e5f9667cd1a540d9e4951) - improve anonymous telemetry setup

- [#77](https://github.com/dmno-dev/varlock/pull/77) [`f49fd2a`](https://github.com/dmno-dev/varlock/commit/f49fd2a2c07f8fc58654d4a1c1bac9fd9ba7df3e) - vite integration

- [#88](https://github.com/dmno-dev/varlock/pull/88) [`33874e8`](https://github.com/dmno-dev/varlock/commit/33874e863227759b299b1745158018fe2393a142) - Add additional format options to load command help

## 0.0.4

### Patch Changes

- [#79](https://github.com/dmno-dev/varlock/pull/79) [`eb27ce8`](https://github.com/dmno-dev/varlock/commit/eb27ce89b6e0c8cfd1693a5430cb65000421e1ac) - onboarding tweaks from user feedback

- [#74](https://github.com/dmno-dev/varlock/pull/74) [`6c1065f`](https://github.com/dmno-dev/varlock/commit/6c1065f628f43d004986783fccbf8fd4f1145bf2) - fix log redaction when there are no sensitive config items

## 0.0.3

### Patch Changes

- [#61](https://github.com/dmno-dev/varlock/pull/61) [`9e7b898`](https://github.com/dmno-dev/varlock/commit/9e7b898ab37359e271adc8d677626d841fa69dfb) - re-publish varlock

## 0.0.2

### Patch Changes

- [#48](https://github.com/dmno-dev/varlock/pull/48) [`6344851`](https://github.com/dmno-dev/varlock/commit/6344851179c97bab08cd12a9b8edb70414893872) - refactor core loading logic, reimplement security features from dmno, process.env type generation

- [#52](https://github.com/dmno-dev/varlock/pull/52) [`04c104b`](https://github.com/dmno-dev/varlock/commit/04c104b770bbd7d6b4138df1d5888770e4ff642d) - Add @defaultSensitive=inferFromPrefix(MY_PREFIX) root level decorator

- [#56](https://github.com/dmno-dev/varlock/pull/56) [`cdd4b4f`](https://github.com/dmno-dev/varlock/commit/cdd4b4f1d11d696a6b71cbbb8c7500e64d16e0b8) - change envFlag handling in prep for nextjs integration and cloud platforms

- [`6d1b5dc`](https://github.com/dmno-dev/varlock/commit/6d1b5dc397d5024f52b07a2449959f2696683239) - remove top level await, to fix SEA build

- [#49](https://github.com/dmno-dev/varlock/pull/49) [`78953bb`](https://github.com/dmno-dev/varlock/commit/78953bb0959a2679ed15971f19e83818c4edc72e) - Added @disable root decorator to bypass file parsing

- [#38](https://github.com/dmno-dev/varlock/pull/38) [`93e0337`](https://github.com/dmno-dev/varlock/commit/93e03371ea29399b739a01d54256a071b13b3692) - load via execSync instead of in same process

- [#42](https://github.com/dmno-dev/varlock/pull/42) [`ec75c3b`](https://github.com/dmno-dev/varlock/commit/ec75c3beabb0043feaf057a3f3581c3b85b49b68) - add nextjs integration

- [#47](https://github.com/dmno-dev/varlock/pull/47) [`711014c`](https://github.com/dmno-dev/varlock/commit/711014c5dd9135ae6b943dbc6ad937db91ff2c97) - Added @defaultRequired=infer root decorator to automatically set any item with a static or function value to be @required

- Updated dependencies [[`cdd4b4f`](https://github.com/dmno-dev/varlock/commit/cdd4b4f1d11d696a6b71cbbb8c7500e64d16e0b8)]:
  - @env-spec/parser@0.0.2

## 0.0.1

### Patch Changes

- [#15](https://github.com/dmno-dev/varlock/pull/15) [`b8e7cf7`](https://github.com/dmno-dev/varlock/commit/b8e7cf7a553c20d2777de6b06a6b6ca73f7afa9c) - add fn resolvers and $ expand support to varlock

- [#33](https://github.com/dmno-dev/varlock/pull/33) [`79da0c7`](https://github.com/dmno-dev/varlock/commit/79da0c7172254770d2c3301bb38e4ecf275eeee5) - update deps

- [#27](https://github.com/dmno-dev/varlock/pull/27) [`1589aa3`](https://github.com/dmno-dev/varlock/commit/1589aa3c231b2a4e16516a57c0f5fa2df1b1a831) - add TS type generation

- [#32](https://github.com/dmno-dev/varlock/pull/32) [`c34f561`](https://github.com/dmno-dev/varlock/commit/c34f561ffd8174ca72a2da74e6f008752b9ea92c) - clean up resolver set up

- [#11](https://github.com/dmno-dev/varlock/pull/11) [`aa034cd`](https://github.com/dmno-dev/varlock/commit/aa034cddfca7e21395e6627e063a9f6b78961dde) - initial release, testing ci pipelines

- [#28](https://github.com/dmno-dev/varlock/pull/28) [`f9cd0f4`](https://github.com/dmno-dev/varlock/commit/f9cd0f47a410642066dc986738bd45f24fc1f697) - - always redact secrets in varlock load output

  - expose utilities for redaction that end users can use directly
  - expose function to enables global console patching

- [#25](https://github.com/dmno-dev/varlock/pull/25) [`1e2207a`](https://github.com/dmno-dev/varlock/commit/1e2207a5df902619151da97b2bcd37e4f4fb24e4) - rename eval to exec

- Updated dependencies [[`b8e7cf7`](https://github.com/dmno-dev/varlock/commit/b8e7cf7a553c20d2777de6b06a6b6ca73f7afa9c), [`aa034cd`](https://github.com/dmno-dev/varlock/commit/aa034cddfca7e21395e6627e063a9f6b78961dde), [`1e2207a`](https://github.com/dmno-dev/varlock/commit/1e2207a5df902619151da97b2bcd37e4f4fb24e4)]:
  - @env-spec/parser@0.0.1
