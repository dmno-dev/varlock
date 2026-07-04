---
varlock: patch
---

`@encryptInjectedEnv` is now honored when `varlock run` / `varlock proxy run` inject the env blob.

Previously the setting only applied to the library auto-load path and build-time integrations; the CLI spawn paths injected a plaintext `__VARLOCK_ENV` blob and merely forwarded a pre-existing key. In blob-only inject mode (`--inject blob`), the blob is now encrypted with an ephemeral key carried alongside it, so resolved values never sit in plaintext in the child's environment. This is leak resistance (crash reporters, env dumps, logs), not protection from an attacker who can read the full environment.
