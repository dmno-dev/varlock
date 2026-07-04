---
varlock: patch
"@varlock/nextjs-integration": patch
---

Fix Next.js pages router and middleware support: webpack builds no longer fail on pages-router files, pages-router SSR picks up reloaded env values in turbopack dev, middleware no longer crashes the dev server with a `Native module not found: crypto` error, and on Next 15.5+ the turbopack loader rule is scoped away from edge files so middleware no longer breaks dev page rendering
