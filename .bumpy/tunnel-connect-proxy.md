---
varlock: minor
---

proxy run --url now dials its tunnel through an HTTP proxy (HTTP(S)_PROXY/NO_PROXY), so a sandboxed agent whose only egress is a proxy gateway (e.g. Docker Sandboxes) can reach a broker
