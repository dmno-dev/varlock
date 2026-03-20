---
"@varlock/nextjs-integration": patch
---

Fix: call `initVarlockEnv()` in the cached-env code path so the `ENV` proxy is properly initialized at runtime (e.g., on Vercel serverless), not just at build time.
