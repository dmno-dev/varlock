---
"@varlock/nextjs-integration": major
---

Builds no longer bake the resolved env into their output unless they freeze it, controlled by the new `freezeIntoBundle` option (`'auto'` by default: freeze on Vercel, Netlify, Cloudflare Workers Builds, AWS Amplify and OpenNext; resolve at boot elsewhere). What to check when upgrading:

- **`output: 'standalone'`** (e.g. Docker images): the build now fails until you set `freezeIntoBundle: true` (bake the env, encrypted; the server needs only `_VARLOCK_ENV_KEY`) or `false` (the server resolves at boot, so the varlock CLI must be available, e.g. `varlock run -- node server.js`). Previously a standalone server with no CLI silently booted from build-time values.
- **Frozen builds must be encrypted**: set `_VARLOCK_ENV_KEY` at build and runtime (generate one with `varlock generate-key`), or opt out with `_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV=1`.
- **`next start` without the varlock CLI** fails at boot with the fixes instead of falling back to build-time values.

A frozen env wins over the environment at boot (with a warning when they differ), and `@dynamic=boot` keys can be set per instance.
