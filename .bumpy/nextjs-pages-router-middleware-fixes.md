---
"@varlock/nextjs-integration": patch
---

Fix pages router and middleware support: webpack builds no longer fail on pages-router files, middleware no longer crashes the dev server, and on Next 15.5+ the turbopack loader rule is scoped away from edge files so middleware doesn't break dev page rendering
