# Env Spec Language - IntelliJ / WebStorm Plugin

Adds syntax highlighting and IntelliSense for [@env-spec](https://varlock.dev/env-spec) enabled `.env` files in IntelliJ IDEA and WebStorm.

## Features

Inspired by the [VS Code / Open VSX extension](../../vscode-plugin):

- **Completion (IntelliSense)** for:
  - Decorators (`@required`, `@type=`, etc.)
  - `@type=` data types (string, number, enum, url, etc.)
  - Type options (e.g. `string(minLength=5)`)
  - Resolver functions (`concat`, `fallback`, `forEnv`, etc.)
  - `$KEY` references
  - Enum values when `@type=enum(...)` is used

- **Inline diagnostics** for:
  - Duplicate single-use decorators
  - Incompatible decorators (`@required` + `@optional`, etc.)
  - Invalid enum values
  - Static value validation (url prependHttps, string length, number range, etc.)

- **Documentation** on hover for decorators

- **Syntax highlighting** for .env and .env.* files:
  - Comment lines (`# …`) vs assignments (`KEY=value`, optional `export`)
  - Colors follow **Settings → Editor → Color Scheme → Env Spec** (defaults match line comments, keywords, keys, `=`, and string-like values)

- **Project view icon** for registered `.env` / `.env.*` files

- **Toggle line comment** (`# `) support

- **Enter on a `#` line** inserts a new line with the same indent and `# ` (block comment continuation)

## Installation

### From JetBrains Marketplace

1. Open **Settings** | **Plugins** | **Marketplace**
2. Search for "Env Spec" or "@env-spec"
3. Install and restart the IDE

### From disk (development)

1. Build the plugin: `./gradlew buildPlugin` (or `./gradlew build`, which includes it)
2. The plugin ZIP is in `build/distributions/`
3. Install via **Settings** | **Plugins** | **⚙️** | **Install Plugin from Disk...**

## Supported file patterns

- `.env`
- `.env.*` (e.g. `.env.schema`, `.env.local`, `.env.example`)

## JetBrains IDE compatibility

This plugin targets the IntelliJ Platform (`com.intellij.modules.platform`), so it is installable in most JetBrains IDEs that support plugins and `.env` workflows (IntelliJ IDEA, WebStorm, PyCharm, PhpStorm, GoLand, RubyMine, CLion, etc.), subject to Marketplace build compatibility.

- Compatibility range is defined in `build.gradle.kts` via `sinceBuild` / `untilBuild`.
- CI release validation runs JetBrains Plugin Verifier (`./gradlew verifyPlugin`) to catch cross-IDE compatibility issues before publishing.

## Requirements

- IntelliJ IDEA 2024.3+ or WebStorm 2024.3+
- **Java 17** (for building) — use a supported JDK for the Gradle version in this repo (see Troubleshooting if you see a cryptic `25` error with Java 25)

## Development

```bash
# Build
./gradlew build

# Run IDE with plugin
./gradlew runIde

# Run tests
./gradlew test
```

## Publishing

### CI (GitHub Actions)

Workflow: [`.github/workflows/extensions-release.yaml`](../../.github/workflows/extensions-release.yaml) (**IntelliJ plugin release**).

Runs only via **Actions → IntelliJ plugin release → Run workflow** (no automatic runs on merge).

| Phase | Behavior |
| --- | --- |
| **Always** | Check out the **ref** you specify, run tests + Plugin Verifier, build the ZIP, upload it as a workflow artifact. |
| **Optional** | Enable **publish** to run `publishPlugin` to JetBrains Marketplace after a successful build. |

Workflow inputs:

| Input | Description |
| --- | --- |
| **ref** | Git ref to build: branch name, tag, or full commit SHA. Default: `main`. |
| **publish** | If enabled, runs the Marketplace publish job after a successful build. If disabled, CI still validates and uploads the ZIP artifact only. Default: off. |

Secrets and varlock-loaded env for CI match local publishing (see `.env.schema`).

### Local / manual Gradle

Publish to JetBrains Marketplace:

```bash
JETBRAINS_MARKETPLACE_TOKEN="<your-marketplace-token>" \
JETBRAINS_CERTIFICATE_CHAIN="<your-certificate-chain>" \
JETBRAINS_PRIVATE_KEY="<your-private-key>" \
JETBRAINS_PRIVATE_KEY_PASSWORD="<your-private-key-password>" \
./gradlew publishPlugin
```

- `publishPlugin` is provided by the IntelliJ Platform Gradle plugin.
- Signing is configured via `JETBRAINS_CERTIFICATE_CHAIN`, `JETBRAINS_PRIVATE_KEY`, and `JETBRAINS_PRIVATE_KEY_PASSWORD`.
- Required publish/signing env vars are documented in `packages/intellij-plugin/.env.schema`.

### Troubleshooting

**Build fails with "What went wrong: 25"** — You're using Java 25, which isn't supported by the Gradle/toolchain used for this plugin. Use Java 17:

```bash
# Homebrew (openjdk@17)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
./gradlew build
```

You can add that `export` to your `~/.zshrc` or run it before each build.

## License

MIT
