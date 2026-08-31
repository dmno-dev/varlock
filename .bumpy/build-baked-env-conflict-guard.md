---
varlock: minor
"@varlock/nextjs-integration": minor
"@varlock/vite-integration": minor
---

When a server boots from the env snapshot baked into the build output (e.g. Next.js standalone in a container where the varlock CLI is unavailable), runtime env vars that conflict with the snapshot now fail the boot loudly, naming the keys and pointing at `varlock run`, instead of being silently ignored or deleted from process.env. Blob-only deploys with no schema values in the runtime env are unaffected; set `_VARLOCK_ALLOW_BAKED_ENV_CONFLICTS=1` to boot on the baked values anyway.
