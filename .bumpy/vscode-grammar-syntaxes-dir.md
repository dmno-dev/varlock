---
env-spec-language: patch
---

Move the TextMate grammar from `language/` to `syntaxes/` (the standard VS Code extension layout, and the location GitHub Linguist's grammar compiler expects); `language-configuration.json` now lives at the extension root.
