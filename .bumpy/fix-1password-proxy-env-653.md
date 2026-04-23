---
"@varlock/1password-plugin": patch
---

Forward proxy environment variables (`http_proxy`, `https_proxy`, `ALL_PROXY`, `NO_PROXY` and case variants) to the `op` subprocess in the batch read path. Fixes secret resolution failures in proxied environments (corporate proxies, Claude Code sandbox, Docker, CI runners behind proxies).
