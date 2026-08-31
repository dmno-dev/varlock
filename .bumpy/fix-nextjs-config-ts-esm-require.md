---
"@varlock/nextjs-integration": patch
---

Fix "exports is not defined in ES module scope" when loading next.config.ts. The plugin's CJS build no longer require()s varlock's ESM-only entry points (they are bundled instead), which broke Next's TypeScript config loader.
