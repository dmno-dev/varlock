# Tree-sitter Varlock Schema

This grammar is based on `zarifpour/tree-sitter-dotenv` and adds Varlock
schema-aware parsing for `# @...` decorator comments in `.env.schema` files.

Zed publishes grammars from a Git repository and revision, so this source tree
is tracked separately from the local `grammars/` development cache.

Regenerate after editing `grammar.js`:

```sh
npm exec --yes --package tree-sitter-cli@0.25.10 tree-sitter -- generate grammar.js
```
