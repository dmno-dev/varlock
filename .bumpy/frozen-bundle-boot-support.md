---
varlock: minor
---

Add `varlock load --defer-boot-required` and the `varlock/frozen-env-boot` runtime bundle, used by framework integrations that freeze the env into their build output. A frozen env now warns once at boot when the environment sets a different value for one of its keys. Fix decrypting an encrypted env in Next.js's local edge runtime, and a re-init reverting `__VARLOCK_ENV` to the value it had at process start.
