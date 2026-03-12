---
"varlock": patch
---

fix: `varlock printenv MY_VAR` was failing with `Variable "printenv" not found in schema` because gunshi includes the subcommand name in `ctx.positionals`. Now correctly slices past the subcommand path to extract the variable name.
