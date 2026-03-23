# Compressed context — Env Spec IntelliJ plugin

## Purpose
JetBrains plugin for [@env-spec](https://varlock.dev/env-spec) on `.env` / `.env.*`: completion, diagnostics, hover, comments, syntax, tests, CI. Parallels the [VS Code extension](../../vscode-plugin).

## Build / toolchain
- **Gradle** 9.0+ (wrapper in repo); **IntelliJ Platform Gradle Plugin** 2.13.x requires Gradle ≥ 9.0.
- **JDK 17** for `./gradlew` (e.g. `JAVA_HOME=/opt/homebrew/opt/openjdk@17`). Java 25 + older Gradle showed a useless `What went wrong: 25` message.
- **Plugin ZIP**: `./gradlew buildPlugin` (or `./gradlew build` — `build` depends on `buildPlugin` in `build.gradle.kts`). Output: `build/distributions/*.zip`.
- **`./gradlew runIde`**: launches a sandbox IDE with the plugin for manual testing and opens the monorepo root (`../..` from `packages/intellij-plugin`) automatically.

## UX / editor (recent)
- **Syntax (comments/decorators)**: Comment lines now tokenize decorators with structure (`@name`, `=`, function name, arg keys/values, commas/parens) instead of a single flat comment token. New token families include `DECORATOR`, `DECORATOR_VALUE`, `DECORATOR_ARG_KEY`, and `DECORATOR_ARG_VALUE`.
- **Syntax (assignment values)**: Assignment values now tokenize resolver function names (`if`, `eq`, etc.) and refs (`$ENV`, `${ENV}`) separately from generic value text, improving parity with VS Code highlighting.
- **Incremental lexing stability**: Lexer now re-tokenizes from true line start (then trims to current offset), preventing state drift where highlights looked correct initially but degraded after incremental rehighlight.
- **Color scheme page**: Added descriptors for decorator subparts, value function calls, and value references in **Settings → Editor → Color Scheme → Env Spec**.
- **Icon**: `src/main/resources/icons/env-spec.svg`; `EnvSpecFileType.getIcon()` via `IconLoader`.
- **Enter on `#` lines**: `EnvSpecCommentEnterHandler` (`EnterHandlerDelegate`) inserts newline + indent + `# `; registered in `plugin.xml` as `enterHandlerDelegate`.
- **Completion insertion behavior**:
  - Fixed duplicate/append issues on accept (Tab/Enter) by replacing `startOffset..tailOffset` instead of static line ranges.
  - Prevents duplicate `@` when accepting decorator suggestions after typing `@`.
  - Type-option completions now insert `optionName=` and place caret directly after `=`.
  - Added snippet normalization for catalog insert text so VS Code-style placeholders are not inserted literally.

## Tests (recent additions)
- Added `EnvSpecLexerTest` coverage for:
  - Decorator segmentation (`@type=enum(...)`, `@generateTypes(...)`)
  - Arg key/value tokenization across multi-arg decorators
  - Incomplete vs closed paren forms
  - Mid-line incremental lexing start offsets
  - Assignment value function/reference tokenization (`if(eq($ENV,...))`)
- Added `EnvSpecCompletionContributorTest` coverage for:
  - Completion match contexts immediately after `=`
  - Snippet text normalization paths

## Key paths
| Area        | Path |
|------------|------|
| Plugin src | `src/main/kotlin/dev/dmno/envspec/` |
| Plugin XML | `src/main/resources/META-INF/plugin.xml` |
| Build      | `build.gradle.kts`, `gradle/wrapper/` |
| Docs       | `README.md` (this file is additive only) |
