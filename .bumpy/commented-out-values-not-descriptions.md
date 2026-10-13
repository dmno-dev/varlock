---
"@env-spec/parser": patch
varlock: patch
---

Commented-out config items (ex: `# API_KEY=prod-value`, including multi-line values) are no longer treated as part of the next item's description, so their values no longer leak into generated types or other description output.
