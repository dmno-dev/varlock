---
"@varlock/vite-integration": minor
"@varlock/nextjs-integration": minor
---

`vite dev` and `next dev` now refuse to start when a `varlock freeze` file (`.varlock-frozen-env`) is present. It is a deploy artifact, so in a dev checkout it is always a leftover, and it would make `varlock run` disagree with your dev server. Delete it, or set `_VARLOCK_USE_FROZEN_ENV=0` to keep it.
