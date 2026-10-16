---
"@varlock/vite-integration": patch
---

Keep secrets logged in React Server Components out of the dev-mode RSC payload: React's dev console replay now gets redacted args, so logging a sensitive value no longer trips leak detection and truncates the page
