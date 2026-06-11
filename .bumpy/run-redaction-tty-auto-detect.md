---
varlock: patch
---

`varlock run` output redaction is now auto-detected per stream.

**Behavior change:** output attached to an interactive terminal now passes through directly (preserving raw TTY behavior, so interactive tools like `psql` and `claude` work without `--no-redact-stdout`), while piped or redirected output (CI logs, files, pipes) is still redacted — that's where leaked secrets actually persist. Detection is per stream, so `varlock run -- app | tee log.txt` redacts stdout while stderr (still on the terminal) passes through.

- Add `--redact-stdout` / `_VARLOCK_REDACT_STDOUT` to override the auto-detection: force redaction of piped output (e.g. to override `@redactLogs=false`). Forcing redaction while attached to an interactive terminal errors, since it isn't possible without breaking TTY behavior. The flag takes precedence over the env var.
- Fix a leak where a secret split across stream chunk boundaries escaped redaction.
- Exclude all reserved `_VARLOCK_*` keys from the injected env blob, generated types, and override provenance (previously only `_VARLOCK_ENV_KEY` / `_VARLOCK_CACHE_KEY` were excluded), and scope override provenance to actual schema config keys instead of mirroring every `process.env` key. Warn when a user defines a config item using the reserved `_VARLOCK_` prefix.
