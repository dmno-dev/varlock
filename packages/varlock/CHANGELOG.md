# varlock

## 0.9.1

### Patch Changes

- [#630](https://github.com/dmno-dev/varlock/pull/630) [`22629d3`](https://github.com/dmno-dev/varlock/commit/22629d31871ab812d819ccf6469819c66d1ea922) - `varlock scan` now accepts optional positional path/glob arguments to scan specific files, directories, or glob patterns instead of the whole repo. This is useful for scanning build output folders (e.g. `dist`, `.next`) to ensure no secrets leaked into what will be published.

  ```sh
  varlock scan ./dist             # Scan a specific build output directory
  varlock scan ./dist ./public    # Scan multiple directories
  varlock scan './dist/**/*.js'   # Scan files matching a glob pattern
  ```

  When explicit paths are provided, git-aware filtering (`--staged`, `--include-ignored`) is bypassed, and build-output directories that are normally skipped (such as `dist`, `.next`, `build`) are scanned without restriction.

## 0.9.0

### Minor Changes

- [#615](https://github.com/dmno-dev/varlock/pull/615) [`9c38e3a`](https://github.com/dmno-dev/varlock/commit/9c38e3a06977263a43a35aafdd07c8ba4253a6e0) - Add `--no-inject-graph` CLI flag to `varlock run` to opt out of injecting the `__VARLOCK_ENV` serialized config graph into the child process environment. This prevents sensitive values from being exposed via environment inspection (e.g., `env`, `printenv`) in interactive shells, long-lived processes, or LLM-driven agents.

### Patch Changes

- [#627](https://github.com/dmno-dev/varlock/pull/627) [`f93c23f`](https://github.com/dmno-dev/varlock/commit/f93c23f15d1cb98f64c2d78de1184fb4edbe5582) - Fix: escape `*/` sequences in item descriptions to prevent premature JSDoc comment closure in generated TypeScript types

- [#622](https://github.com/dmno-dev/varlock/pull/622) [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617) - Fix leak detection for Uint8Array/ArrayBuffer response bodies

  `scanForLeaks` now detects secrets in `Uint8Array`, `ArrayBufferView`, and `ArrayBuffer` values. Previously these fell through unscanned, so secrets returned as binary-encoded response bodies (common in Cloudflare Workers) were not caught.

## 0.8.2

### Patch Changes

- [#620](https://github.com/dmno-dev/varlock/pull/620) [`0f3ca3b`](https://github.com/dmno-dev/varlock/commit/0f3ca3be2231cae9e6f12ee8a6fdebb180a76baf) - Fix regex literal parsing ambiguity with file paths

  Removed grammar-level regex literal (`/pattern/`) parsing which caused paths like `/folder/foo/bar` to be incorrectly parsed as regex patterns. Regex-like strings are now detected at runtime by specific consumers (`remap()` match values, `matches` type option) instead of at the grammar level. Unquoted strings that look like `/pattern/flags` are treated as regex in those contexts; wrap in quotes to force literal string matching.

- [#618](https://github.com/dmno-dev/varlock/pull/618) [`0db7d1d`](https://github.com/dmno-dev/varlock/commit/0db7d1dcd3999578f45f81c90ba39bff6daf4cae) - Fix `varlock run` on Windows: correctly build the cmd.exe command string when spawning `.cmd`/`.bat` files

  Previously, individual arguments were double-quoted separately (e.g. `"tsx.cmd" "watch" "src/index.ts"`). Because cmd.exe's `/s /c` strips only the **first and last** quote from the entire command string, this left a stray `"` after the command name, causing errors like "The system cannot find the path specified."

  The fix wraps the entire inner command string in a single pair of outer quotes (e.g. `"tsx.cmd watch src/index.ts"`), which is what cmd.exe expects. Paths or arguments that contain spaces are individually quoted inside those outer quotes.

  Additionally, when `findCommand` cannot resolve a bare command name to a `.cmd`/`.bat` path, varlock now falls back to routing through cmd.exe so that Windows PATHEXT lookups (e.g. `tsx` → `tsx.cmd`, `pnpm` → `pnpm.cmd`) are handled automatically.

## 0.8.1

### Patch Changes

- [#610](https://github.com/dmno-dev/varlock/pull/610) [`753086e`](https://github.com/dmno-dev/varlock/commit/753086ef927fa5895dabad190d35401fd6647e6a) - fix: `noTrailingSlash` url type option now correctly rejects URLs like `https://example.com/`

## 0.8.0

### Minor Changes

- [#593](https://github.com/dmno-dev/varlock/pull/593) [`2abe62a`](https://github.com/dmno-dev/varlock/commit/2abe62a5b6f7871512559b526a519edea920daf6) Thanks [@kjs3](https://github.com/kjs3)! - Added support for specifying multiple `--path` / `-p` flags from the CLI (e.g. `varlock load -p ./envs -p ./overrides`). Later paths take higher precedence. This brings the CLI to parity with the existing `package.json` `varlock.loadPath` array support.

- [#599](https://github.com/dmno-dev/varlock/pull/599) [`c498964`](https://github.com/dmno-dev/varlock/commit/c498964d09cb11c51be5f24ff7aca985c8014542) - Add `noTrailingSlash` and `matches` (regex) options to the `url` data type. Add regex literal syntax (`/pattern/flags`) as a new language feature, deprecating the `regex()` function wrapper.

- [#602](https://github.com/dmno-dev/varlock/pull/602) [`5841609`](https://github.com/dmno-dev/varlock/commit/58416095932529080543ddffe0208e5deadf6ac3) - In non-CI environments, `VARLOCK_BRANCH` now auto-detects the current git branch via `git branch --show-current`. Previously it was only populated in CI environments from platform environment variables.

### Patch Changes

- [#592](https://github.com/dmno-dev/varlock/pull/592) [`6031678`](https://github.com/dmno-dev/varlock/commit/603167834c11c0c989f1c4ccfb2e38b6d7dbb27b) Thanks [@TeaSeaLancs](https://github.com/TeaSeaLancs)! - Fix execSyncVarlock not working in a shell-less environment

- [#594](https://github.com/dmno-dev/varlock/pull/594) [`baee30d`](https://github.com/dmno-dev/varlock/commit/baee30dd23d005435ba58b01ff8c597eeb199768) - Fix `declare module 'varlock/env'` type augmentation breaking in monorepo setups where multiple packages each have their own `.env.schema` and generated `env.d.ts`. Use unique type aliases per schema so that `CoercedEnvSchema` and `EnvSchemaAsStrings` names don't collide when multiple `env.d.ts` files are in the same TypeScript compilation.

- [#596](https://github.com/dmno-dev/varlock/pull/596) [`3170205`](https://github.com/dmno-dev/varlock/commit/31702054208cb81bc4d7c5ad89bf32a718984397) - Fix false warning 'found in environment but not connected to plugin' when standard vars are already wired via init decorator (e.g. `@initOp(token=$OP_SERVICE_ACCOUNT_TOKEN)`)

## 0.7.4

### Patch Changes

- [#590](https://github.com/dmno-dev/varlock/pull/590) [`e9b3935`](https://github.com/dmno-dev/varlock/commit/e9b3935884ef0bec037c0baab66ce8af56696a2c) - Fix varlock binary detection on Windows with pnpm - now also checks for varlock.cmd in addition to varlock.exe, since pnpm does not create .exe shims

## 0.7.3

### Patch Changes

- [#583](https://github.com/dmno-dev/varlock/pull/583) [`f640d08`](https://github.com/dmno-dev/varlock/commit/f640d081088feaa88fd9e855b3cc815cc271b08b) - Builtin vars now have proper types: `VARLOCK_IS_CI` is now a `boolean` (was a string `"true"`/`"false"`), and `VARLOCK_BUILD_URL` is now a `url` type. String builtin vars remain unchanged.

- [#581](https://github.com/dmno-dev/varlock/pull/581) [`8337445`](https://github.com/dmno-dev/varlock/commit/83374450753a1c1093120ed591f0c1d4c2bf71cf) - Fix `varlock init` crashing on Linux when git is not installed.

  When `git` is not found in PATH, Node.js `spawn` fires an `error` event with a native ENOENT error that has no `.data` property. The `checkIsFileGitIgnored` utility was trying to call `.includes()` on the undefined `.data` value before reaching the ENOENT check, causing a `TypeError` that crashed the `init` command.

  The fix reorders the error checks to handle the ENOENT case first, and uses optional chaining on the `errorOutput` value throughout for additional safety.

- [#575](https://github.com/dmno-dev/varlock/pull/575) [`349d517`](https://github.com/dmno-dev/varlock/commit/349d517ee9bd84e12c4e7715e23b7fa2074a6f28) - Fix terminal colors when running commands with redaction enabled. When `varlock run` pipes stdout/stderr for redaction, it now automatically injects `FORCE_COLOR` into the child process environment when the parent terminal is a TTY. This preserves color output for tools using color libraries (chalk, kleur, etc.) while keeping redaction active.

- [#571](https://github.com/dmno-dev/varlock/pull/571) [`f582766`](https://github.com/dmno-dev/varlock/commit/f58276693e26d384397c737946cb8111a64877e5) - Support multiple `loadPath` entries in `package.json` configuration.

  The `varlock.loadPath` option in `package.json` now accepts an array of paths in addition to a single string. When an array is provided, all paths are loaded and their environment variables are combined. Later entries in the array take higher precedence when the same variable is defined in multiple locations.

  ```json title="package.json"
  {
    "varlock": {
      "loadPath": ["./apps/my-package/envs/", "./apps/other-package/envs/"]
    }
  }
  ```

  This is particularly useful in monorepos where different packages each have their own `.env` files.

## 0.7.2

### Patch Changes

- [#538](https://github.com/dmno-dev/varlock/pull/538) [`2022ef7`](https://github.com/dmno-dev/varlock/commit/2022ef7c8b2070f40c0cd787f0cc75a595a679e4) - feat: allow 3rd party plugins

  Third-party (non-`@varlock/*`) plugins are now supported:

  - **JavaScript projects**: Any plugin installed in `node_modules` via `package.json` is automatically trusted and can be used without restriction.
  - **Standalone binary**: When downloading a third-party plugin from npm for the first time, Varlock will prompt for interactive confirmation. Once confirmed and cached, subsequent runs skip the prompt. Non-interactive environments (CI/piped) will receive a clear error message instructing the user to confirm interactively or install via `package.json`.

- [#534](https://github.com/dmno-dev/varlock/pull/534) [`74752a3`](https://github.com/dmno-dev/varlock/commit/74752a3db9459538b8ef7d984737f5bb55de17ae) - Add version mismatch detection between standalone binary and local node_modules install

  When running the standalone binary (installed via homebrew/curl), varlock now checks if a different version is installed in the project's node_modules. If a version mismatch is detected, a warning is displayed suggesting users update the binary or use the locally installed version instead. This helps prevent confusing errors caused by running mismatched versions.

- [#560](https://github.com/dmno-dev/varlock/pull/560) [`0ea6641`](https://github.com/dmno-dev/varlock/commit/0ea66411604966f744e311fdf59df71d5a3da127) - Add `varlock explain ITEM_KEY` command and override indicators in `varlock load` output.

  **Override indicators**: When a config item's value comes from a `process.env` override rather than its file-based definitions, `varlock load` now shows a yellow indicator on that item. This helps users understand why their resolver functions (e.g. `op()`) are not being called.

  **`varlock explain` command**: Shows detailed information about how a single config item is resolved, including all definitions and sources in priority order, which source is active, whether a process.env override is in effect (and what would be used without it), decorators, type info, and documentation links.

- [#553](https://github.com/dmno-dev/varlock/pull/553) [`6ab2d31`](https://github.com/dmno-dev/varlock/commit/6ab2d31903b80ab4d8ec0eb826a18789e73e8f11) - Fix diamond dependency handling when the same schema is imported via multiple paths. Previously, duplicate imports caused plugin init decorators to run twice ("Instance already initialized" error). Now, duplicate imports create lightweight `ImportAliasSource` nodes that appear at the correct precedence position without re-initializing the source. This correctly handles different importKeys subsets across import sites and preserves override semantics matching non-deduplicated behavior. Also adds `type` field to serialized source entries for easier filtering.

- [#558](https://github.com/dmno-dev/varlock/pull/558) [`01c9a6a`](https://github.com/dmno-dev/varlock/commit/01c9a6a5398d31d3818953dd757d3263e0cf3a36) - Fix plugin resolution failure in monorepo workspaces where `.git` and the lockfile coexist in the same directory.

  `detectWorkspaceInfo()` was checking for a `.git` directory **after** moving to the parent, so in the standard monorepo layout (`monorepo-root/.git` + `monorepo-root/bun.lock`) the root was never scanned and the lockfile was never found. Moving the `.git` boundary check to **before** moving up ensures the git-root directory is always scanned first.

- [#547](https://github.com/dmno-dev/varlock/pull/547) [`1a4b0cf`](https://github.com/dmno-dev/varlock/commit/1a4b0cf4185c4152be4b39c70755316f1a8be25d) - Fix binary resolution in monorepos when `cwd` differs from the package root.

  When importing `varlock/auto-load` (e.g. from a `playwright.config.ts` in a monorepo sub-package), VS Code and similar tools may set `process.cwd()` to the workspace root rather than the sub-package directory. This caused `execSyncVarlock` to search for the `varlock` binary starting at the workspace root and fail to find it when it was only installed in a sub-package's `node_modules/.bin`.

  Two fixes are applied:

  1. `execSyncVarlock` now accepts a `callerDir` option. When provided, the binary search walks up from `callerDir` before falling back to `process.cwd()`. `auto-load.ts` passes `import.meta.dirname` so the search always starts from inside the varlock package itself, which is already in the correct sub-package's `node_modules`.

  2. The walk-up logic no longer throws immediately when it finds a `node_modules/.bin` directory that does not contain varlock. It now continues walking up, allowing the search to find varlock installed at a higher or lower level of a monorepo.

- [#542](https://github.com/dmno-dev/varlock/pull/542) [`02e82d0`](https://github.com/dmno-dev/varlock/commit/02e82d07b4b9d810dba8d1925a27d9fd2c0abab3) - Fix Vitest workspace projects in monorepos: when running Vitest from the monorepo root using the `projects` config, varlock now correctly resolves `.env.schema` and `.env` files from each child package's directory instead of only looking in the monorepo root.

- [#550](https://github.com/dmno-dev/varlock/pull/550) [`0c27ed1`](https://github.com/dmno-dev/varlock/commit/0c27ed10b3b77571848974a3703d77e1eabb8abd) - Fix `@generateTypes` not creating variables when using a custom path with `varlock typegen --path <file>`

  When a schema file with an environment-qualifier-like name (e.g. `.env.infra.schema`) was passed as the explicit entry point via `--path`, its variables were being excluded from type generation. The filename was parsed such that `infra` was treated as an environment name (`applyForEnv='infra'`), causing the data source to be marked as environment-specific and all its variables to be filtered out.

  The fix ensures that a file loaded as the root entry point (no parent data source) is never treated as environment-specific, even if its filename contains an environment qualifier.

## 0.7.1

### Patch Changes

- [#540](https://github.com/dmno-dev/varlock/pull/540) [`0d25aa5`](https://github.com/dmno-dev/varlock/commit/0d25aa5e6973e9fc0cf5054e444c0ded28a186f0) - Fix incorrect validation error message for `endsWith` string constraint - it was saying "Value must start with" instead of "Value must end with"

- [#543](https://github.com/dmno-dev/varlock/pull/543) [`004e181`](https://github.com/dmno-dev/varlock/commit/004e181ec44251a75be45efafc85846bb3874467) - Fix execSyncVarlock breaking when project path contains spaces

  Use `execFileSync` instead of `execSync` for the fallback varlock path resolution to avoid shell interpretation of spaces in directory paths.

- [#527](https://github.com/dmno-dev/varlock/pull/527) [`e67ee2f`](https://github.com/dmno-dev/varlock/commit/e67ee2f5c6b09b91564eba3925de560c12ca80c3) - Improve invalid config handling in CLI and Vite integration

  - `varlock load --format json-full` now outputs partial JSON (with `errors` field) even when validation fails, enabling consumers to access sources and valid config items
  - Vite plugin gracefully handles invalid config in dev mode: shows error page and automatically recovers when the config is fixed
  - Vite build output now includes specific error details when config validation fails

## 0.7.0

### Minor Changes

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

### Patch Changes

- [#503](https://github.com/dmno-dev/varlock/pull/503) [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8) - Fix Docker image failing to run due to missing `libstdc++` and `libgcc_s` shared libraries on Alpine Linux. The bun-compiled binary dynamically links against these C++ runtime libraries, which are now installed in the Docker image via `apk add libstdc++`.

- [#507](https://github.com/dmno-dev/varlock/pull/507) [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee) - Fix @import(enabled=...) and @disable conditions not seeing values from .env, .env.local, and env-specific files

  Previously, import conditions and imported file @disable decorators were evaluated during .env.schema's initialization, before other files (.env, .env.local, .env.ENV, .env.ENV.local) were loaded. This meant that variables set in those files were not available when resolving conditions like `enabled=eq($AUTH_MODE, "azure")` or `@disable=not(eq($AUTH_MODE, "azure"))`.

  Now, DirectoryDataSource loads all auto-loaded files first (registering their config items), then processes imports in a separate pass. This ensures all file values are available when import/disable conditions are evaluated.

- [#495](https://github.com/dmno-dev/varlock/pull/495) [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3) - Fix: error messages in `varlock load` now go to stderr instead of stdout.

  Previously, error output from `checkForSchemaErrors` and `checkForConfigErrors` was written to stdout via `console.log`, which polluted the JSON output when using `--format json-full`. This caused `import 'varlock/config'` to fail with a JSON parse error when a plugin (e.g. AWS secrets) encountered an error. Error messages are now written to stderr, keeping stdout clean for JSON output.

## 0.6.4

### Patch Changes

- [#490](https://github.com/dmno-dev/varlock/pull/490) [`2959826`](https://github.com/dmno-dev/varlock/commit/2959826c6c89c732a9318cfe037dd928813c50b7) - Fix process crash when config folder is not writable (e.g., in Kubernetes containers). The anonymous ID write failure now logs at debug level and continues gracefully instead of calling `gracefulExit(1)`.

- [#472](https://github.com/dmno-dev/varlock/pull/472) [`0ca309d`](https://github.com/dmno-dev/varlock/commit/0ca309dea1ecabfc456d01679064f2862dd75809) - Fix: `varlock load --format shell` now properly escapes special characters in values.

  Values are now wrapped in single quotes instead of double quotes, preventing shell injection via backticks, `$()` subshell syntax, and variable expansion (`$VAR`). Single quotes within values are safely escaped using the `'\''` sequence.

- [#475](https://github.com/dmno-dev/varlock/pull/475) [`583c2f8`](https://github.com/dmno-dev/varlock/commit/583c2f8405db8c60915767990d12f9469e34ffcb) Thanks [@developerzeke](https://github.com/developerzeke)! - Add ts-nocheck directive to ts type-generation output

- [#481](https://github.com/dmno-dev/varlock/pull/481) [`80c0475`](https://github.com/dmno-dev/varlock/commit/80c04751e5cd58bb185ddac50386490ea20479cd) - Fix: invalid load path errors now throw a `CliExitError` instead of logging and calling `gracefulExit`, for consistent error handling across the CLI.

## 0.6.3

### Patch Changes

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
