# varlock

## 0.1.5

### Patch Changes

- [#252](https://github.com/dmno-dev/varlock/pull/252) [`2c91174`](https://github.com/dmno-dev/varlock/commit/2c91174404be57208a5a865ed9335f8985a3e11e) Thanks [@theoephraim](https://github.com/theoephraim)! - apply redaction to stdout and sterr in `varlock run`

## 0.1.4

### Patch Changes

- [#245](https://github.com/dmno-dev/varlock/pull/245) [`901fada`](https://github.com/dmno-dev/varlock/commit/901fada4e2aa2cc93dbd13441bdff37ab0896e2d) Thanks [@theoephraim](https://github.com/theoephraim)! - disable `@generateTypes` in imported files

## 0.1.3

### Patch Changes

- [#216](https://github.com/dmno-dev/varlock/pull/216) [`23ed768`](https://github.com/dmno-dev/varlock/commit/23ed76867f673ec1d7bf420632be1d902678becc) Thanks [@theoephraim](https://github.com/theoephraim)! - fix runtime env code to not assume process (or shim) exists - for sveltekit

- Updated dependencies [[`82a7340`](https://github.com/dmno-dev/varlock/commit/82a7340a695d62a40c908c37432c6d9cfd7e2c3d)]:
  - @env-spec/parser@0.0.8

## 0.1.2

### Patch Changes

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) Thanks [@theoephraim](https://github.com/theoephraim)! - allow if() to take 1 arg to coerce to boolean

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) Thanks [@theoephraim](https://github.com/theoephraim)! - allow @required/@sensitive to accept undefined

- [#204](https://github.com/dmno-dev/varlock/pull/204) [`6f4e998`](https://github.com/dmno-dev/varlock/commit/6f4e9984bd5bb398b4fabd5d20a1283e41e66dd4) Thanks [@theoephraim](https://github.com/theoephraim)! - fix logic around finding the varlock executable to work with windows .cmd files

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) Thanks [@theoephraim](https://github.com/theoephraim)! - make ENV readonly without making process.env readonly

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) Thanks [@theoephraim](https://github.com/theoephraim)! - adjust loading behavior for browser testing (vitest jsdom)

- [#203](https://github.com/dmno-dev/varlock/pull/203) [`3a16d45`](https://github.com/dmno-dev/varlock/commit/3a16d455cacb7378561d256693b154a8ba4ff737) Thanks [@theoephraim](https://github.com/theoephraim)! - add not() and isEmpty() resolvers

## 0.1.1

### Patch Changes

- [#200](https://github.com/dmno-dev/varlock/pull/200) [`f98a63f`](https://github.com/dmno-dev/varlock/commit/f98a63fdb68f461bf02bc1797a406f45f5afd875) Thanks [@theoephraim](https://github.com/theoephraim)! - add project-level config file

- [#201](https://github.com/dmno-dev/varlock/pull/201) [`e65e1c9`](https://github.com/dmno-dev/varlock/commit/e65e1c97b98d5d24ef84fc72c01c52a19e36ea01) Thanks [@theoephraim](https://github.com/theoephraim)! - use process.cwd() instead of process.env.PWD

## 0.1.0

### Minor Changes

- [#168](https://github.com/dmno-dev/varlock/pull/168) [`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8) Thanks [@theoephraim](https://github.com/theoephraim)! - unify resolvers with decorators, new plugin system, 1pass plugin

### Patch Changes

- [#186](https://github.com/dmno-dev/varlock/pull/186) [`8bae875`](https://github.com/dmno-dev/varlock/commit/8bae875503c5f9a9d84bc772ad41be1fb3e4febd) Thanks [@theoephraim](https://github.com/theoephraim)! - dep updates

- Updated dependencies [[`9161687`](https://github.com/dmno-dev/varlock/commit/91616873a3101b83399de3311742bc79764b89a8)]:
  - @env-spec/parser@0.0.7

## 0.0.15

### Patch Changes

- [#162](https://github.com/dmno-dev/varlock/pull/162) [`b6fc6dd`](https://github.com/dmno-dev/varlock/commit/b6fc6dd396b87b02c1e7e72d6fe84b493c29776f) Thanks [@theoephraim](https://github.com/theoephraim)! - fix import relative path issues

- [#163](https://github.com/dmno-dev/varlock/pull/163) [`8d31513`](https://github.com/dmno-dev/varlock/commit/8d315132de5d2b40f4c6423d10747cbc848d3392) Thanks [@theoephraim](https://github.com/theoephraim)! - fix issue with executable path when running directly instead of via package manager

## 0.0.14

### Patch Changes

- [#157](https://github.com/dmno-dev/varlock/pull/157) [`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd) Thanks [@theoephraim](https://github.com/theoephraim)! - adjust server response leak detection for no content type

- [#158](https://github.com/dmno-dev/varlock/pull/158) [`999016c`](https://github.com/dmno-dev/varlock/commit/999016c0ec6bd83aa4ee3975d93a553beba4be3d) Thanks [@theoephraim](https://github.com/theoephraim)! - allow setting envFlag from an imported file

- [#157](https://github.com/dmno-dev/varlock/pull/157) [`e33940e`](https://github.com/dmno-dev/varlock/commit/e33940e96c1801c8c6428e461d5bd80448c9e0fd) Thanks [@theoephraim](https://github.com/theoephraim)! - set defaultRequired to infer during varlock init

- [#160](https://github.com/dmno-dev/varlock/pull/160) [`9025edc`](https://github.com/dmno-dev/varlock/commit/9025edcdc0e60d0ac587cbae7b5fc28fd7b7b5e6) Thanks [@theoephraim](https://github.com/theoephraim)! - fix URL data type validation error mesage

- Updated dependencies [[`7b3e2f4`](https://github.com/dmno-dev/varlock/commit/7b3e2f4fb50dfd81ea1e1ba1a9298fd6be53ea6f)]:
  - @env-spec/parser@0.0.6

## 0.0.13

### Patch Changes

- [#147](https://github.com/dmno-dev/varlock/pull/147) [`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f) Thanks [@theoephraim](https://github.com/theoephraim)! - new @import decorator

- Updated dependencies [[`9d9c8de`](https://github.com/dmno-dev/varlock/commit/9d9c8dee64f972026112c975181737df6634c05f)]:
  - @env-spec/parser@0.0.5

## 0.0.12

### Patch Changes

- [#125](https://github.com/dmno-dev/varlock/pull/125) [`0d00628`](https://github.com/dmno-dev/varlock/commit/0d00628cf3ecc33211abc18f40636233a7141928) Thanks [@philmillman](https://github.com/philmillman)! - restrict @envFlag to being used in .env.schema

- [#138](https://github.com/dmno-dev/varlock/pull/138) [`89d4255`](https://github.com/dmno-dev/varlock/commit/89d4255d7e32dffe660d486a18ca5ddb1b2ceb88) Thanks [@philmillman](https://github.com/philmillman)! - remove envFlag normalization

- [#136](https://github.com/dmno-dev/varlock/pull/136) [`851aaf0`](https://github.com/dmno-dev/varlock/commit/851aaf0e4f575882e97079c8fdfe6c1a2dba5c08) Thanks [@theoephraim](https://github.com/theoephraim)! - add new `forEnv()` helper for @required decorator, to allow dynamically setting required-ness based on current env flag

## 0.0.11

### Patch Changes

- [#132](https://github.com/dmno-dev/varlock/pull/132) [`330bd92`](https://github.com/dmno-dev/varlock/commit/330bd921bbbae0b64a7c98e321711d6e87c49843) Thanks [@theoephraim](https://github.com/theoephraim)! - fix logic around setting process.env and handling empty/undefined vals

## 0.0.10

### Patch Changes

- [#130](https://github.com/dmno-dev/varlock/pull/130) [`17206e8`](https://github.com/dmno-dev/varlock/commit/17206e86e10ca178ce2e6115ecf1d42b4e8dce7e) Thanks [@theoephraim](https://github.com/theoephraim)! - fix for astro+vite plugin

## 0.0.9

### Patch Changes

- [#116](https://github.com/dmno-dev/varlock/pull/116) [`9e8b40a`](https://github.com/dmno-dev/varlock/commit/9e8b40a04360dc78c82d29da261f378a0d2d92f5) Thanks [@theoephraim](https://github.com/theoephraim)! - fix bug with global Response patching (for cloudflare)

- [#114](https://github.com/dmno-dev/varlock/pull/114) [`86c02bf`](https://github.com/dmno-dev/varlock/commit/86c02bf7f5283c487c576e884699f94863b4773e) Thanks [@philmillman](https://github.com/philmillman)! - Fixed git not installed error

## 0.0.8

### Patch Changes

- [#98](https://github.com/dmno-dev/varlock/pull/98) [`f4ed06e`](https://github.com/dmno-dev/varlock/commit/f4ed06eb62c7aa0bc858e0e710e620bd330604fa) Thanks [@philmillman](https://github.com/philmillman)! - add internal export

- [#109](https://github.com/dmno-dev/varlock/pull/109) [`1bc2650`](https://github.com/dmno-dev/varlock/commit/1bc26508760c8dd4940393f40e94b00d9a2f2688) Thanks [@theoephraim](https://github.com/theoephraim)! - ignore .envrc files - only .env and .env.\* will be loaded

- [#111](https://github.com/dmno-dev/varlock/pull/111) [`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4) Thanks [@theoephraim](https://github.com/theoephraim)! - update deps

- Updated dependencies [[`429b7cc`](https://github.com/dmno-dev/varlock/commit/429b7ccf084f9d7630f31e0fcb9e5366c1c199a4)]:
  - @env-spec/parser@0.0.4

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
