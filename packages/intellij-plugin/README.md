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

### Troubleshooting

**Build fails with "What went wrong: 25"** — You're using Java 25, which Gradle 8.x doesn't support. Use Java 17:

```bash
# Homebrew (openjdk@17)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
./gradlew build
```

You can add that `export` to your `~/.zshrc` or run it before each build.

## License

MIT
