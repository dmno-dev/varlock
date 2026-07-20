---
varlock: patch
---

Add `varlock proxy`: a local credential proxy for AI agents (preview).

Run an agent (or any untrusted tool) through a local MITM proxy so it only ever sees placeholder secrets: real values are injected at the wire (bound to a verified upstream TLS identity), responses are scrubbed back to placeholders, and every request is policy-checked and audited. Mark a secret with `@proxy(domain="api.example.com")`; sensitive items are shown to the child as placeholders by default, with `@proxy=passthrough` / `@proxy=omit` escape hatches. Route with host/path/method rules (`block`, `approval`), set egress with `@proxyConfig={egress="strict"}`, and hot-reload live policy with `varlock proxy reload`. Sessions are durable and auditable (`varlock proxy status` / `rules` / `audit`); `proxy start` runs a daemon with a live request log that other `proxy run` invocations attach to. Add `proxy run --sandbox` to run the agent in a sandbox whose only egress is the proxy: a built-in macOS credential + egress jail, or `--sandbox=docker` (`=podman`) to run it in a container while your secrets stay on the host. Preview: on its own the proxy is same-uid and raises the bar rather than being a boundary; `--sandbox` (or a container) is what makes it one. See the [proxy guide](https://varlock.dev/guides/proxy/).
