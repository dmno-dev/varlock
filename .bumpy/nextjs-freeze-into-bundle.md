---
"@varlock/nextjs-integration": major
---

Freeze the env into the build output only on Vercel, Netlify, Cloudflare Workers Builds and OpenNext builds, or when `freezeIntoBundle: true` is set. Other builds no longer bake the resolved env in: `next start` and standalone servers resolve at boot, and fail at boot with the fixes if the varlock CLI is unavailable (previously a standalone server silently fell back to build-time values). A frozen build must be encrypted with `_VARLOCK_ENV_KEY` (opt out with `_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV=1`), its values win over the environment at boot, and `@dynamic=boot` keys can be set per instance.
