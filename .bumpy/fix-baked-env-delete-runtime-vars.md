---
varlock: patch
"@varlock/nextjs-integration": patch
"@varlock/vite-integration": patch
---

Fixes runtime-provided env vars being deleted from `process.env` when a server boots from the env snapshot baked into the build output (e.g. a Next.js standalone container where the varlock CLI is unavailable). Introduced in 1.17.1, this could take down a service that passes config at boot with `docker run -e ...`.
