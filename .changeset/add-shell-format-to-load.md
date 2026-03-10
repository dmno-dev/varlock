---
"varlock": patch
---

Add `shell` output format to `varlock load` command. `--format shell` outputs `export KEY=VALUE` lines suitable for `eval` or sourcing into the current shell session, enabling easy integration with tools like [direnv](https://direnv.net/).
