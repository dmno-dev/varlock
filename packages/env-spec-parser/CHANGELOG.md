# @env-spec/parser

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
