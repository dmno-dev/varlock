# env-spec-language















## 0.4.1
<sub>2026-09-04</sub>

- [#1064](https://github.com/dmno-dev/varlock/pull/1064)  *(patch)*
  Data type fixes. `@type=enum` now matches numeric and boolean members against string values from `process.env` and `overrideValues`, so `LEVEL=2` or `FLAG=true` from CI satisfies `enum(1, 2, 3)` / `enum(true, false)`. `@type=url` matches `allowedDomains` in full against the URL host instead of as a substring, which previously let `example.com` pass an allowlist of `myexample.com`; write two or more hosts as an array (`allowedDomains=[a.com, b.com]`), since a comma inside a single string now errors and names the array to use. An `allowedDomains` entry without a port now allows any port, so `allowedDomains=[localhost]` accepts `http://localhost:3000`; add a port to pin it. Each entry must be a hostname with an optional port; an empty list, or a scheme, path, or credentials in an entry, now errors instead of silently matching the wrong host or nothing at all. VS Code diagnostics for `allowedDomains`, `allowedProtocols` and `noTrailingSlash` were reporting different results than an actual load, and now match. `@env-spec/parser` exports `autoCoerce` so tooling can classify unquoted values exactly as the parser does. `@type=url(noTrailingSlash=true)` now also catches a trailing slash that is followed by a query string or hash, such as `https://example.com/path/?q=1`. `@type=ip(version=6)` accepts IPv4-mapped addresses like `::ffff:192.168.1.1`. `@type=md5` accepts uppercase hex and normalizes it to lowercase. `@type=port` rejects non-integers such as `80.5`.

## 0.4.0
<sub>2026-09-01</sub>

- [#1045](https://github.com/dmno-dev/varlock/pull/1045)  *(minor)* - Add completions and diagnostics for the new `domain` data type
- [#1043](https://github.com/dmno-dev/varlock/pull/1043)  *(minor)* Thanks [@app/pullfrog](https://github.com/app/pullfrog)! - Added allowed protocol validation for URL values.

## 0.3.3
<sub>2026-08-25</sub>

- [#1021](https://github.com/dmno-dev/varlock/pull/1021)  *(patch)* - Build with tsdown instead of tsup; published files now use explicit .mjs/.cjs extensions.

## 0.3.2
<sub>2026-07-31</sub>

- [#960](https://github.com/dmno-dev/varlock/pull/960)  *(patch)* - Add generateOtp() to autocomplete

## 0.3.1
<sub>2026-07-28</sub>

- [#944](https://github.com/dmno-dev/varlock/pull/944)  *(patch)* - Fix false "can only be used once" diagnostic for multiline plugin init decorators (e.g. `@initInfisical(`)

## 0.3.0
<sub>2026-07-21</sub>

- [#917](https://github.com/dmno-dev/varlock/pull/917)  *(minor)*
  Add array and object value types: `@type=array(...)` and `@type=record(...)` with per-element validation, native `[a, b]` / `{k=v}` literal values, JSON and separator string input, configurable serialization back to process.env, per-element redaction, and typed code generation across languages

## 0.2.7
<sub>2026-07-20</sub>

- [#892](https://github.com/dmno-dev/varlock/pull/892)  *(patch)* - Add `@generateJavaEnv` and `@generateCsharpEnv` loadable env modules (typed Env, loader, sensitive keys)

## 0.2.6
<sub>2026-07-15</sub>

- [#873](https://github.com/dmno-dev/varlock/pull/873)  *(patch)*
  Add editor autocomplete and hover docs for the new `@tag()` decorator, the `filter=` arg on `@generate*` decorators, and `@internal`

## 0.2.5
<sub>2026-07-06</sub>

- [#849](https://github.com/dmno-dev/varlock/pull/849)  *(patch)*
  Generate code for Python, Rust, Go, and PHP with new per-language decorators (`@generatePythonEnv`, `@generateRustEnv`, `@generateGoEnv`, `@generatePhpEnv`). Each emits a self-contained, idiomatic module — typed coerced values, a loader that parses the injected env, and a `SENSITIVE_KEYS` constant — so it's usable out of the box. The TypeScript generator moves to `@generateTsTypes` and gains options to control `process.env`/`import.meta.env` augmentation and a monorepo-friendly `exposeEnv=local` mode. `@generateTypes(lang=ts)` still works as a deprecated alias. The `varlock typegen` command is renamed to `varlock codegen` (with `typegen` kept as a deprecated alias). Note: `@disableProcessEnvInjection` now requires a static `true`/`false` value — env-dependent values like `forEnv(prod)` are a schema error, since generated code must not differ per environment.

## 0.2.4
<sub>2026-06-23</sub>

- [#816](https://github.com/dmno-dev/varlock/pull/816)  *(patch)* - Improve syntax highlighting for array/object literals: highlight bare item-value literals (e.g. `KEY=[a, b]`, `KEY={ k=v }`) and fix unindented (column-0) comments inside multi-line `fn(...)` literals

## 0.2.3
<sub>2026-06-17</sub>

- [#792](https://github.com/dmno-dev/varlock/pull/792)  *(patch)* - Maintenance release — no functional changes (switches Marketplace publishing to OIDC)
- [#794](https://github.com/dmno-dev/varlock/pull/794)  *(patch)* - Object and array literals can now span multiple lines. Inside decorators each continuation line is prefixed with `#` (like multi-line function calls), e.g. a long `@import(./.env.shared, pick=[ ... ])` key list; literals nested in item-value function calls use plain newlines. Single-line literals are unchanged.
  Multi-line literals and function calls also support `#` comments — full-line entries can be commented out (`# # OLD_KEY,`) and individual entries annotated with trailing comments (`# KEY, # note`).
  The VSCode extension's syntax highlighting now understands object/array literals (single- and multi-line) and these inline comments.
- [#795](https://github.com/dmno-dev/varlock/pull/795)  *(patch)* - Fix syntax highlighting: closing paren in a nested decorator function call (e.g. @dec(fn())) no longer shows as an error

## 0.2.2
<sub>2026-06-16</sub>

- [#786](https://github.com/dmno-dev/varlock/pull/786)  *(patch)* - `@setValuesBulk` and `@import` support `pick`/`omit` key filters.
  Filter which keys are brought in with `pick` (allowlist) or `omit` (denylist) array args — e.g. `@setValuesBulk(opLoadEnvironment(env-id), pick=[API_KEY, DB_*])` or `@import(./.env.shared, omit=[LEGACY_TOKEN])`. By default every key is included; `pick` and `omit` can't be combined, and both accept simple globs (`*`, `?`).
  For `@import`, listing keys as positional args (`@import(./.env.shared, KEY1, KEY2)`) is now deprecated in favor of `pick=[...]` — it still works but warns.

## 0.2.1
<sub>2026-06-03</sub>

- [#742](https://github.com/dmno-dev/varlock/pull/742)  *(patch)* Thanks [@Shtian](https://github.com/Shtian)! - Fixed URL fragments in @docs() decorator not being highlighted correctly.

## 0.2.0
<sub>2026-05-11</sub>

- [#569](https://github.com/dmno-dev/varlock/pull/569) Thanks [@danish-fareed](https://github.com/danish-fareed)! - add code env scanner and audit command with `@auditIgnore` / `@auditIgnorePaths` decorators

## 0.1.3

### Patch Changes

- [#620](https://github.com/dmno-dev/varlock/pull/620) [`0f3ca3b`](https://github.com/dmno-dev/varlock/commit/0f3ca3be2231cae9e6f12ee8a6fdebb180a76baf) - Fix regex literal parsing ambiguity with file paths

  Removed grammar-level regex literal (`/pattern/`) parsing which caused paths like `/folder/foo/bar` to be incorrectly parsed as regex patterns. Regex-like strings are now detected at runtime by specific consumers (`remap()` match values, `matches` type option) instead of at the grammar level. Unquoted strings that look like `/pattern/flags` are treated as regex in those contexts; wrap in quotes to force literal string matching.

## 0.1.2

### Patch Changes

- [#599](https://github.com/dmno-dev/varlock/pull/599) [`c498964`](https://github.com/dmno-dev/varlock/commit/c498964d09cb11c51be5f24ff7aca985c8014542) - Add `noTrailingSlash` and `matches` (regex) options to the `url` data type. Add regex literal syntax (`/pattern/flags`) as a new language feature, deprecating the `regex()` function wrapper.

## 0.1.1

### Patch Changes

- [#467](https://github.com/dmno-dev/varlock/pull/467) [`72f1ef0`](https://github.com/dmno-dev/varlock/commit/72f1ef00167eaf0a2ac61ca443beb6ba2f24c4c3) Thanks [@voiys](https://github.com/voiys)! - Fix VS Code diagnostics and completions so decorator parsing ignores prose mentions and post-comments while still matching parser behavior for leading `@word` comment lines.

- [#468](https://github.com/dmno-dev/varlock/pull/468) [`6313f82`](https://github.com/dmno-dev/varlock/commit/6313f827d80df996c41491ccffc1b9fc90efcc4c) Thanks [@voiys](https://github.com/voiys)! - Fix duplicate decorator diagnostics so repeated function-style decorators stay valid and split header root decorators still share one header scope.

## 0.1.0

### Minor Changes

- [#370](https://github.com/dmno-dev/varlock/pull/370) [`5fa49f7`](https://github.com/dmno-dev/varlock/commit/5fa49f7aa25e2b7d13dc0980c19b200bf0e470a7) Thanks [@voiys](https://github.com/voiys)! - Add IntelliSense, inline diagnostics, and docs demos for the VS Code extension.

## 0.0.5

### Patch Changes

- [#327](https://github.com/dmno-dev/varlock/pull/327) [`2359444`](https://github.com/dmno-dev/varlock/commit/2359444e9298f8bd572ac62ddbb1861b40bd9878) - trigger publishing again

## 0.0.4

### Patch Changes

- [#325](https://github.com/dmno-dev/varlock/pull/325) [`c3bf828`](https://github.com/dmno-dev/varlock/commit/c3bf828460abf1097b7e1baf547a47a389c523d3) - trigger automated publishing

## 0.0.3

### Patch Changes

- [#320](https://github.com/dmno-dev/varlock/pull/320) [`0992470`](https://github.com/dmno-dev/varlock/commit/09924708b11bd361632cc4d1eea103a448a85cf3) - multi-line function calls, many highlighting fixes
