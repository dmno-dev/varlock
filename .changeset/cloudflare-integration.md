---
"@varlock/cloudflare-integration": minor
"@varlock/vite-integration": minor
---

New `@varlock/cloudflare-integration` package for Cloudflare Workers

- `varlockCloudflareVitePlugin()` — Vite plugin that reads secrets from Cloudflare bindings at runtime instead of bundling them into worker code
- `varlock-wrangler` CLI — drop-in wrangler replacement that uploads non-sensitive values as vars and sensitive values as secrets on deploy; injects env into miniflare via Unix named pipe in dev; watches .env files for changes; generates correct Env types
- `@varlock/cloudflare-integration/init` — standalone init module for non-Vite workers
- `resolvedEnvVars()` helper for injecting vars into miniflare bindings in Vite dev

Refactors `@varlock/vite-integration` to remove Cloudflare-specific logic and add generic extension points (`ssrEntryCode`, `ssrEdgeRuntime`, `ssrEntryModuleIds`, `ssrInjectModeDev`) for platform integrations.
