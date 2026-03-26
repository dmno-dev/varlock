---
"varlock": patch
---

Fix: error messages in `varlock load` now go to stderr instead of stdout.

Previously, error output from `checkForSchemaErrors` and `checkForConfigErrors` was written to stdout via `console.log`, which polluted the JSON output when using `--format json-full`. This caused `import 'varlock/config'` to fail with a JSON parse error when a plugin (e.g. AWS secrets) encountered an error. Error messages are now written to stderr, keeping stdout clean for JSON output.
