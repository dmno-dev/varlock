---
"@varlock/nextjs-integration": patch
---

Improved loader caching: only disable cache for files that reference `ENV.` (turbopack only), allowing most files to benefit from build caching. Updated docs and README to reflect full Next.js 15/16 and Turbopack support.
