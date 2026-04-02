---
"varlock": minor
---

feat: allow 3rd party plugins

Third-party (non-`@varlock/*`) plugins are now supported:

- **JavaScript projects**: Any plugin installed in `node_modules` via `package.json` is automatically trusted and can be used without restriction.
- **Standalone binary**: When downloading a third-party plugin from npm for the first time, Varlock will prompt for interactive confirmation. Once confirmed and cached, subsequent runs skip the prompt. Non-interactive environments (CI/piped) will receive a clear error message instructing the user to confirm interactively or install via `package.json`.
