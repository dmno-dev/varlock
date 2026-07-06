---
"@varlock/nextjs-integration": patch
---

Fix pages router and middleware support: webpack builds no longer fail on pages-router files, pages-router SSR picks up reloaded env values in turbopack dev, middleware no longer crashes the dev server or gets rejected by Vercel's edge bundle analyzer, works with turbopack dev on Next 15.5+, and encrypted deployments now work in middleware and edge routes
