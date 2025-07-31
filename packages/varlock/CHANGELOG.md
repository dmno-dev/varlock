# varlock

## 0.0.7

### Patch Changes

- [#101](https://github.com/dmno-dev/varlock/pull/101) [`48d1c4d`](https://github.com/dmno-dev/varlock/commit/48d1c4d76eb40e0b44321fc5ff7073daa4707702) Thanks [@theoephraim](https://github.com/theoephraim)! - new astro integration, based on vite integration

- [#103](https://github.com/dmno-dev/varlock/pull/103) [`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f) Thanks [@theoephraim](https://github.com/theoephraim)! - chore: update dependencies

- Updated dependencies [[`d657b50`](https://github.com/dmno-dev/varlock/commit/d657b501013ce88ac65cb523ca8d61cb4f941a1f)]:
  - @env-spec/parser@0.0.3

## 0.0.6

### Patch Changes

- [#91](https://github.com/dmno-dev/varlock/pull/91) [`186d6ed`](https://github.com/dmno-dev/varlock/commit/186d6ed2fdf0ace184510b99c222d15a1c1d83a9) Thanks [@theoephraim](https://github.com/theoephraim)! - init bugfixes

## 0.0.5

### Patch Changes

- [#84](https://github.com/dmno-dev/varlock/pull/84) [`7407999`](https://github.com/dmno-dev/varlock/commit/7407999d58394fe5ce6e5f9667cd1a540d9e4951) Thanks [@theoephraim](https://github.com/theoephraim)! - improve anonymous telemetry setup

- [#77](https://github.com/dmno-dev/varlock/pull/77) [`f49fd2a`](https://github.com/dmno-dev/varlock/commit/f49fd2a2c07f8fc58654d4a1c1bac9fd9ba7df3e) Thanks [@theoephraim](https://github.com/theoephraim)! - vite integration

- [#88](https://github.com/dmno-dev/varlock/pull/88) [`33874e8`](https://github.com/dmno-dev/varlock/commit/33874e863227759b299b1745158018fe2393a142) Thanks [@philmillman](https://github.com/philmillman)! - Add additional format options to load command help

## 0.0.4

### Patch Changes

- [#79](https://github.com/dmno-dev/varlock/pull/79) [`eb27ce8`](https://github.com/dmno-dev/varlock/commit/eb27ce89b6e0c8cfd1693a5430cb65000421e1ac) Thanks [@theoephraim](https://github.com/theoephraim)! - onboarding tweaks from user feedback

- [#74](https://github.com/dmno-dev/varlock/pull/74) [`6c1065f`](https://github.com/dmno-dev/varlock/commit/6c1065f628f43d004986783fccbf8fd4f1145bf2) Thanks [@theoephraim](https://github.com/theoephraim)! - fix log redaction when there are no sensitive config items

## 0.0.3

### Patch Changes

- [#61](https://github.com/dmno-dev/varlock/pull/61) [`9e7b898`](https://github.com/dmno-dev/varlock/commit/9e7b898ab37359e271adc8d677626d841fa69dfb) Thanks [@theoephraim](https://github.com/theoephraim)! - re-publish varlock

## 0.0.2

### Patch Changes

- [#48](https://github.com/dmno-dev/varlock/pull/48) [`6344851`](https://github.com/dmno-dev/varlock/commit/6344851179c97bab08cd12a9b8edb70414893872) Thanks [@theoephraim](https://github.com/theoephraim)! - refactor core loading logic, reimplement security features from dmno, process.env type generation

- [#52](https://github.com/dmno-dev/varlock/pull/52) [`04c104b`](https://github.com/dmno-dev/varlock/commit/04c104b770bbd7d6b4138df1d5888770e4ff642d) Thanks [@philmillman](https://github.com/philmillman)! - Add @defaultSensitive=inferFromPrefix(MY_PREFIX) root level decorator

- [#56](https://github.com/dmno-dev/varlock/pull/56) [`cdd4b4f`](https://github.com/dmno-dev/varlock/commit/cdd4b4f1d11d696a6b71cbbb8c7500e64d16e0b8) Thanks [@theoephraim](https://github.com/theoephraim)! - change envFlag handling in prep for nextjs integration and cloud platforms

- [`6d1b5dc`](https://github.com/dmno-dev/varlock/commit/6d1b5dc397d5024f52b07a2449959f2696683239) Thanks [@theoephraim](https://github.com/theoephraim)! - remove top level await, to fix SEA build

- [#49](https://github.com/dmno-dev/varlock/pull/49) [`78953bb`](https://github.com/dmno-dev/varlock/commit/78953bb0959a2679ed15971f19e83818c4edc72e) Thanks [@philmillman](https://github.com/philmillman)! - Added @disable root decorator to bypass file parsing

- [#38](https://github.com/dmno-dev/varlock/pull/38) [`93e0337`](https://github.com/dmno-dev/varlock/commit/93e03371ea29399b739a01d54256a071b13b3692) Thanks [@theoephraim](https://github.com/theoephraim)! - load via execSync instead of in same process

- [#42](https://github.com/dmno-dev/varlock/pull/42) [`ec75c3b`](https://github.com/dmno-dev/varlock/commit/ec75c3beabb0043feaf057a3f3581c3b85b49b68) Thanks [@theoephraim](https://github.com/theoephraim)! - add nextjs integration

- [#47](https://github.com/dmno-dev/varlock/pull/47) [`711014c`](https://github.com/dmno-dev/varlock/commit/711014c5dd9135ae6b943dbc6ad937db91ff2c97) Thanks [@philmillman](https://github.com/philmillman)! - Added @defaultRequired=infer root decorator to automatically set any item with a static or function value to be @required

- Updated dependencies [[`cdd4b4f`](https://github.com/dmno-dev/varlock/commit/cdd4b4f1d11d696a6b71cbbb8c7500e64d16e0b8)]:
  - @env-spec/parser@0.0.2

## 0.0.1

### Patch Changes

- [#15](https://github.com/dmno-dev/varlock/pull/15) [`b8e7cf7`](https://github.com/dmno-dev/varlock/commit/b8e7cf7a553c20d2777de6b06a6b6ca73f7afa9c) Thanks [@theoephraim](https://github.com/theoephraim)! - add fn resolvers and $ expand support to varlock

- [#33](https://github.com/dmno-dev/varlock/pull/33) [`79da0c7`](https://github.com/dmno-dev/varlock/commit/79da0c7172254770d2c3301bb38e4ecf275eeee5) Thanks [@theoephraim](https://github.com/theoephraim)! - update deps

- [#27](https://github.com/dmno-dev/varlock/pull/27) [`1589aa3`](https://github.com/dmno-dev/varlock/commit/1589aa3c231b2a4e16516a57c0f5fa2df1b1a831) Thanks [@theoephraim](https://github.com/theoephraim)! - add TS type generation

- [#32](https://github.com/dmno-dev/varlock/pull/32) [`c34f561`](https://github.com/dmno-dev/varlock/commit/c34f561ffd8174ca72a2da74e6f008752b9ea92c) Thanks [@theoephraim](https://github.com/theoephraim)! - clean up resolver set up

- [#11](https://github.com/dmno-dev/varlock/pull/11) [`aa034cd`](https://github.com/dmno-dev/varlock/commit/aa034cddfca7e21395e6627e063a9f6b78961dde) Thanks [@theoephraim](https://github.com/theoephraim)! - initial release, testing ci pipelines

- [#28](https://github.com/dmno-dev/varlock/pull/28) [`f9cd0f4`](https://github.com/dmno-dev/varlock/commit/f9cd0f47a410642066dc986738bd45f24fc1f697) Thanks [@theoephraim](https://github.com/theoephraim)! - - always redact secrets in varlock load output

  - expose utilities for redaction that end users can use directly
  - expose function to enables global console patching

- [#25](https://github.com/dmno-dev/varlock/pull/25) [`1e2207a`](https://github.com/dmno-dev/varlock/commit/1e2207a5df902619151da97b2bcd37e4f4fb24e4) Thanks [@theoephraim](https://github.com/theoephraim)! - rename eval to exec

- Updated dependencies [[`b8e7cf7`](https://github.com/dmno-dev/varlock/commit/b8e7cf7a553c20d2777de6b06a6b6ca73f7afa9c), [`aa034cd`](https://github.com/dmno-dev/varlock/commit/aa034cddfca7e21395e6627e063a9f6b78961dde), [`1e2207a`](https://github.com/dmno-dev/varlock/commit/1e2207a5df902619151da97b2bcd37e4f4fb24e4)]:
  - @env-spec/parser@0.0.1
