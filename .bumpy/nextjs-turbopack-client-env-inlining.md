---
"@varlock/nextjs-integration": patch
---

Fix `ENV` values being `undefined` in the browser with Turbopack when read from monorepo workspace packages outside the app directory, or from browser-only files without a 'use client' directive (such as `instrumentation-client.ts`) in dev
