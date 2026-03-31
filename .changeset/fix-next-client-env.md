---
"@varlock/nextjs-integration": patch
---

- fix: public `ENV.*` replacement now works in `'use client'` components under Turbopack — the loader previously bailed out early for client modules, skipping the static replacement pass entirely
