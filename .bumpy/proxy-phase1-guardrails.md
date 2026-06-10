---
varlock: patch
---

Add proxy guardrails and strict egress enforcement for run --proxy.

Local-MVP hardening: per-item domain scoping (an item's secret is injected only on hosts its own rule matches), response redaction of headers + uncompressed bodies (compressed bodies pass through — most APIs don't reflect credentials, and forcing identity on every request wasn't worth the cost), schema-fingerprint enforcement on nested commands (closes the @sensitive-downgrade re-load), and correctness fixes (byte-accurate content-length, strict-mode 403 length).

In-memory ephemeral CA: cert generation moved from the `openssl` subprocess to `@peculiar/x509` over WebCrypto (EC P-256). CA and per-host leaf private keys are now generated and held in memory — only the public CA cert is written to disk for child trust. Removes the openssl dependency (portability for the compiled binary) and closes the on-disk private-key exposure. Leaf certs for IP-literal ruled domains now use an IP SAN (clients verify IPs against iPAddress, not dNSName), so IP-based `@proxy` domains work. Validated end-to-end through the compiled binary (real HTTPS MITM) and via an in-process TLS integration test.

Process-ancestry context detection: nested-command guards and placeholder overrides now detect the proxy session by matching a running session's owner/child PID against the current process's parent chain, not just the inherited `__VARLOCK_PROXY_CHILD` marker. Closes the `env -u __VARLOCK_PROXY_CHILD varlock load` bypass that previously recovered real values; a child would now have to daemonize/reparent to escape the process tree. Marker-absent-but-ancestry-positive is logged as a likely bypass probe.

Streaming responses: the proxy no longer buffers `text/event-stream` (and other unknown-length) responses for body redaction — they stream through incrementally, so LLM/agent token-by-token responses work. Body redaction now applies only to bounded, small (<2MB content-length) text responses; header redaction still applies to all responses.

Placeholder generation: the placeholder is functionally load-bearing (a bad one fails an SDK's key-format check at client construction), so generation now favors known-format sources. `@example` derivation was removed (a docs field shouldn't double as a validation-critical placeholder); priority is explicit `@placeholder` → data-type `generatePlaceholder()` → `@type` constraints → generic fallback. Items that land on the generic fallback are flagged and a warning is printed at proxy startup.
