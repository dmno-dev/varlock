---
varlock: minor
---

Reach the credential proxy from another machine or a remote sandbox, with no external tunnel tool. `varlock proxy start` / `run` gain `--tunnel` (optionally `--tunnel=<addr>`) to serve a built-in CONNECT-over-WebSocket tunnel off-loopback, so a client behind provider HTTP ingress (E2B, Modal, ...) can route through it. Enabling the tunnel mints a per-session data-plane token that clients must present (pin it with `VARLOCK_PROXY_TOKEN`), while loopback clients stay exempt and the control endpoint stays loopback-only. `varlock proxy run --url <wss-url> --token <token> -- <command>` runs the command through a broker running elsewhere: it opens the tunnel, self-wires the env and CA certs from the broker, and only ever holds placeholders. `varlock proxy env` also gains `--full` (emit the whole child-view env, not just the wiring) with `--proxy-url` / `--cert-dir` to repoint it, for wiring a client manually.
