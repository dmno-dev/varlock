---
"varlock": patch
---

Fix false warning 'found in environment but not connected to plugin' when standard vars are already wired via init decorator (e.g. `@initOp(token=$OP_SERVICE_ACCOUNT_TOKEN)`)
