---
"@varlock/penv-plugin": minor
---

Add the penv plugin: load secrets from penv.cloud. `@penv=org/project` names the project, `@initPenv()` takes `environment`, `token`, `url`, `org`, `project` and `cacheTtl`, `penv()` reads one value by address (`KEY`, `env/KEY`, `project/env/KEY`, `org/project/env/KEY`, or the item key when called with no argument), and `penvBulk()` loads a whole environment for `@setValuesBulk()`. The same `.env.schema` also runs under the penv CLI.
