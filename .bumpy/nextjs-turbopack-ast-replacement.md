---
"@varlock/nextjs-integration": patch
---

fix turbopack static ENV replacement corrupting ENV.x references inside string literals and comments — replacement is now AST-based, matching the vite integration
