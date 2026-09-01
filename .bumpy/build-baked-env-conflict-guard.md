---
varlock: minor
"@varlock/nextjs-integration": minor
"@varlock/vite-integration": minor
---

Fixes runtime-provided env vars being deleted from `process.env` when a server boots from the env snapshot baked into the build output (e.g. Next.js standalone in a container where the varlock CLI is unavailable). Introduced in 1.17.1, this could take down a service that passes config at boot with `docker run -e ...`. Baked values remain authoritative for `ENV`, and a runtime env var that differs from the snapshot is now logged as a warning naming the keys instead of being ignored silently.
