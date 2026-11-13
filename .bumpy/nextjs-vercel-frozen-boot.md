---
"@varlock/nextjs-integration": patch
---

Fix frozen builds exiting at boot on Vercel, where Next.js leaves the config `env` out of the build output. Rewritten Turbopack runtime files now also get matching content hashes in the build's file traces.
