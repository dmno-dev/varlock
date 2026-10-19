---
varlock: minor
"@varlock/vite-integration": patch
"@varlock/cloudflare-integration": patch
"@varlock/astro-integration": patch
"@varlock/nextjs-integration": patch
---

New `varlock/auto-init` entry: a single edge-safe import that initializes the runtime from an already-resolved env (decrypting it if needed) and applies all runtime patches, without calling the CLI. The same sequence is available as a function, `initVarlockRuntime()` from `varlock/init`, for code that has to set up its inputs first. The Next.js integration now injects one `varlock/init-bundle` file into both server and edge runtimes (`varlock/init-server` and `varlock/init-edge` remain as aliases of it). `varlock/patch-server-response` now loads node builtins lazily and is a no-op where `node:http` does not exist, so the same init code runs in Node, Bun, Cloudflare Workers and Vercel Edge. The vite, Cloudflare and Astro integrations use it instead of assembling the init sequence module by module; the vite plugin's `ssrEdgeRuntime` option is no longer needed and is ignored.
