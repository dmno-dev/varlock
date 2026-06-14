---
varlock: patch
---

`varlock proxy run` attaches to a running proxy when possible.

Instead of always starting a fresh (auto-deny) proxy, `proxy run` now attaches to a `proxy start` daemon for the current directory — so the daemon's terminal handles approval prompts while you run the agent in another. It picks the single running session whose directory contains yours (or use `--session <id>`), validates the schema fingerprint (and tells you to restart the proxy on drift, rather than silently routing through a stale one), and injects the session's proxy env + placeholders. Pass `--new` to force a separate fresh proxy. This is the missing piece that makes interactive approval usable from a `run`-style agent command.
