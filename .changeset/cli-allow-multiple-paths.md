---
"varlock": patch
---

Added support for specifying multiple `--path` / `-p` flags from the CLI (e.g. `varlock load -p ./envs -p ./overrides`). Later paths take higher precedence. This brings the CLI to parity with the existing `package.json` `varlock.loadPath` array support.
