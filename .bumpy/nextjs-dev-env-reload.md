---
"@varlock/nextjs-integration": patch
---

Fix dev-server env file reloading on turbopack and Next 16. Two issues: (1) on Next 16 only the render worker calls `loadEnvConfig`, so the extra env-file watchers were never installed — watcher ownership is now claimed by whichever process loads env first; (2) on turbopack, non-sensitive `ENV.x` values were statically inlined into server files at compile time, so reloaded values were never served — in dev, server-side (node runtime) files now read env through the runtime proxy, which stays fresh across reloads. Client components and edge files still inline values (required), so those keep needing a page refresh after a full recompile.
