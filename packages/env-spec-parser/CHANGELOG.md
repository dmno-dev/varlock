# @env-spec/parser








## 0.4.2
<sub>2026-07-20</sub>

- [#889](https://github.com/dmno-dev/varlock/pull/889)  *(patch)* - Fix $(...) truncation on nested parentheses and dropped spaces before $VAR/${VAR} inside unquoted exec expansion

## 0.4.1
<sub>2026-06-17</sub>

- [#794](https://github.com/dmno-dev/varlock/pull/794)  *(patch)* - Object and array literals can now span multiple lines. Inside decorators each continuation line is prefixed with `#` (like multi-line function calls), e.g. a long `@import(./.env.shared, pick=[ ... ])` key list; literals nested in item-value function calls use plain newlines. Single-line literals are unchanged.
  Multi-line literals and function calls also support `#` comments — full-line entries can be commented out (`# # OLD_KEY,`) and individual entries annotated with trailing comments (`# KEY, # note`).
  The VSCode extension's syntax highlighting now understands object/array literals (single- and multi-line) and these inline comments.

## 0.4.0
<sub>2026-06-16</sub>

- [#783](https://github.com/dmno-dev/varlock/pull/783)  *(minor)* - Add per-item leak-detection opt-out via `@sensitive={preventLeaks=false}`. Secrets that legitimately leave the system (e.g. an API endpoint that returns a secret to another service) can be excluded from runtime leak detection while still being redacted in logs. The options form also accepts `enabled` to toggle sensitivity (including dynamically, e.g. `@sensitive={enabled=forEnv(production)}`).
  Adds standalone object (`{key=value}`) and array (`[a, b, c]`) literals to the env-spec grammar, usable as decorator values and function-call arguments (including nested). `()` remains reserved for function calls.

## 0.3.5
<sub>2026-06-10</sub>

- [#757](https://github.com/dmno-dev/varlock/pull/757)  *(patch)* Thanks [@yinjs](https://github.com/yinjs)! - fix: treat whitespace-only lines as blank lines instead of throwing a parse error

## 0.3.4
<sub>2026-06-03</sub>

- [#742](https://github.com/dmno-dev/varlock/pull/742)  *(patch)* Thanks [@Shtian](https://github.com/Shtian)! - Fixed URL fragments in @docs() decorator not being highlighted correctly.

## 0.3.3
<sub>2026-05-29</sub>

- [#724](https://github.com/dmno-dev/varlock/pull/724)  *(patch)* - improve stray text handling on decorator lines - decorators after stray text are no longer silently ignored

## 0.3.2
<sub>2026-05-24</sub>

- [#708](https://github.com/dmno-dev/varlock/pull/708) - decorator name validation and warnings

## 0.3.1

### Patch Changes

- [#620](https://github.com/dmno-dev/varlock/pull/620) [`0f3ca3b`](https://github.com/dmno-dev/varlock/commit/0f3ca3be2231cae9e6f12ee8a6fdebb180a76baf) - Fix regex literal parsing ambiguity with file paths

  Removed grammar-level regex literal (`/pattern/`) parsing which caused paths like `/folder/foo/bar` to be incorrectly parsed as regex patterns. Regex-like strings are now detected at runtime by specific consumers (`remap()` match values, `matches` type option) instead of at the grammar level. Unquoted strings that look like `/pattern/flags` are treated as regex in those contexts; wrap in quotes to force literal string matching.

## 0.3.0

### Minor Changes

- [#599](https://github.com/dmno-dev/varlock/pull/599) [`c498964`](https://github.com/dmno-dev/varlock/commit/c498964d09cb11c51be5f24ff7aca985c8014542) - Add `noTrailingSlash` and `matches` (regex) options to the `url` data type. Add regex literal syntax (`/pattern/flags`) as a new language feature, deprecating the `regex()` function wrapper.

## 0.2.0

### Minor Changes

- [#406](https://github.com/dmno-dev/varlock/pull/406) [`ca51993`](https://github.com/dmno-dev/varlock/commit/ca5199371cd6126794e215f67cfcc5f20342eaaa) - Relax header divider requirement - the header block no longer requires a trailing `# ---` divider. All comment blocks before the first config item are now treated as part of the header. Add validation errors for misplaced decorators: item decorators in the header, root decorators on config items, and decorators in detached comment blocks.

## 0.1.1

### Patch Changes

- [#307](https://github.com/dmno-dev/varlock/pull/307) [`2af0b2f`](https://github.com/dmno-dev/varlock/commit/2af0b2f8ae4aff3a89a53e22cd9483abce22ea39) - add 1password environments loader, improve how resolver errors are shown to the user

## 0.1.0

### Minor Changes

- [#278](https://github.com/dmno-dev/varlock/pull/278) [`fe893e2`](https://github.com/dmno-dev/varlock/commit/fe893e2e0635eb42c46ee395b0054356767db10d) - allow multi-line fn calls, both in decorator and item values

## 0.0.8

### Patch Changes

- [#219](https://github.com/dmno-dev/varlock/pull/219) [`82a7340`](https://github.com/dmno-dev/varlock/commit/82a7340a695d62a40c908c37432c6d9cfd7e2c3d) - Fixed a bug where values that resembled very large numbers were being improperly coerced

## 0.0.7

### Patch Changes

- [#168](https://github.com/dmno-dev/varlock/pull/168) [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8) - unify resolvers with decorators, new plugin system, 1pass plugin

## 0.0.6

### Patch Changes

- [#159](https://github.com/dmno-dev/varlock/pull/159) [`7b3e2f4`](https://github.com/dmno-dev/varlock/commit/7b3e2f4fb50dfd81ea1e1ba1a9298fd6be53ea6f) - support \r\n newlines

## 0.0.5

### Patch Changes

- [#147](https://github.com/dmno-dev/varlock/pull/147) [`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f) - new @import decorator

## 0.0.4

### Patch Changes

- [#111](https://github.com/dmno-dev/varlock/pull/111) [`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4) - update deps

## 0.0.3

### Patch Changes

- [#103](https://github.com/dmno-dev/varlock/pull/103) [`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f) - chore: update dependencies

## 0.0.2

### Patch Changes

- [#56](https://github.com/dmno-dev/varlock/pull/56) [`cdd4b4f`](https://github.com/dmno-dev/varlock/commit/cdd4b4f1d11d696a6b71cbbb8c7500e64d16e0b8) - allow nested fn calls in key-value fn call args

## 0.0.1

### Patch Changes

- [#15](https://github.com/dmno-dev/varlock/pull/15) [`b8e7cf7`](https://github.com/dmno-dev/varlock/commit/b8e7cf7a553c20d2777de6b06a6b6ca73f7afa9c) - add fn resolvers and $ expand support to varlock

- [#11](https://github.com/dmno-dev/varlock/pull/11) [`aa034cd`](https://github.com/dmno-dev/varlock/commit/aa034cddfca7e21395e6627e063a9f6b78961dde) - initial release, testing ci pipelines

- [#25](https://github.com/dmno-dev/varlock/pull/25) [`1e2207a`](https://github.com/dmno-dev/varlock/commit/1e2207a5df902619151da97b2bcd37e4f4fb24e4) - rename eval to exec
