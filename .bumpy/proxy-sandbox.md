---
varlock: minor
---

Add `proxy run --sandbox` — run the agent in a sandbox whose only egress is the proxy. Bare `--sandbox` uses a built-in macOS credential + egress jail; `--sandbox=docker` (or `=podman`) runs the agent in a container on an internal network, with secrets staying on the host. Closes the same-uid escape.
