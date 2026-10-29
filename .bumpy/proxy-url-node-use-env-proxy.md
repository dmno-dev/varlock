---
varlock: patch
---

`proxy run --url` now sets `NODE_USE_ENV_PROXY=1` in the child, so Node's built-in `fetch` routes through a remote broker like it does locally.
