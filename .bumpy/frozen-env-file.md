---
varlock: minor
---

Add `varlock freeze` to resolve env values once at deploy time and write them to an encrypted file that ships inside your deploy artifact. Your app boots from that file instead of re-resolving, so config is pinned to the release and rolls back with it. Aimed at apps with no build step (Elysia, Hono, Fastify) on platforms where env vars can't be set atomically with a deploy.
