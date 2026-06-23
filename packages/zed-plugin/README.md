# Varlock Schema Zed Extension

Zed port of the Varlock VS Code `@env-spec` extension for `.env.schema` files.

## Features

- `.env.schema` language registration for Zed
- Tree-sitter highlighting via a Varlock-aware dotenv grammar
- `#` line comments, quote/brace auto-closing, and bracket pairs
- LSP-backed completions for decorators, `@type` values/options, resolver functions, `$KEY` references, and enum item values
- LSP-backed diagnostics for incompatible decorators, duplicate decorators, enum values, and static `@type` mismatches
- LSP-backed hover documentation for known `@decorators`

## Structure

- `extension.toml` registers the Zed extension, language server, and dotenv grammar.
- `languages/env/` contains Zed language configuration and highlight queries.
- `tree-sitter-varlock-schema/` contains the publishable grammar source used by Zed.
- `src/lib.rs` is the Zed extension bridge that launches the bundled Node LSP.
- `server/src/` contains the TypeScript LSP source. Most core parsing/catalog behavior is copied from `dmno-dev/varlock/packages/vscode-plugin`.
- `server/out/` is the generated CommonJS server used by Zed.

## Development

Install dependencies and rebuild the server from `server/`:

```sh
npm install
npm run build
```

The server is built from `server/src/` into `server/out/server.js`, which Zed uses when the folder is installed as a dev extension.

In Zed, install this folder as a dev extension.

Open a `.env.schema` file and confirm the language mode is `Varlock Schema`.
If Zed keeps opening `.env.schema` files as `Shell Script`, add this file type
override to your Zed `settings.json`:

```json
{
  "file_types": {
    "Varlock Schema": [".env.schema", "*.env.schema"]
  }
}
```

## Publishing

Zed publishes grammars from a Git repository and revision. Before opening the
PR to `zed-industries/extensions`, pin the grammar entry to a commit that
contains `packages/zed-plugin/tree-sitter-varlock-schema/`:

```sh
git add packages/zed-plugin/tree-sitter-varlock-schema
git commit -m "Add Varlock schema tree-sitter grammar"
node packages/zed-plugin/scripts/pin-grammar.mjs
git add packages/zed-plugin/extension.toml
git commit -m "Pin Varlock schema grammar"
```

Then publish the bundled language-server release asset. The release tag must
match `extension.toml` and `src/lib.rs`:

```sh
node packages/zed-plugin/scripts/release.mjs
```

In the `zed-industries/extensions` PR, use the same version from
`extension.toml`.
