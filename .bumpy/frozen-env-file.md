---
varlock: minor
---

Add `varlock freeze` for apps with no framework integration baking env into the build (Elysia, Hono, Fastify, compiled binaries): it resolves every value once at deploy time into an encrypted file that ships inside the release, and with `_VARLOCK_USE_FROZEN_ENV=1` set at runtime the app boots from that file with no varlock CLI, `.env` files, or resolver credentials present. Framework integrations already freeze in build output (`ssrInjectMode: 'resolved-env'`, picked automatically on some platforms), and Cloudflare Workers use `varlock-wrangler deploy`, so those users need nothing new. See the [frozen env guide](https://varlock.dev/guides/frozen-env/) for details, including `@dynamic=boot` for values the platform sets per instance.
