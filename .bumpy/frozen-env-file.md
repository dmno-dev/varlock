---
varlock: minor
---

Add `varlock freeze` to resolve env values once at deploy time and write them to an encrypted file that ships inside your deploy artifact. Your app boots from that file instead of re-resolving, so config is pinned to the release and rolls back with it. Aimed at apps with no build step (Elysia, Hono, Fastify) on platforms where env vars can't be set atomically with a deploy. Use `--out -` to get the same payload on stdout when your platform takes env vars but gives you no way to ship a file.
