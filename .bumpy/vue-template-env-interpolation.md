---
"@varlock/vite-integration": patch
---

Fix build-time inlining of ENV values referenced directly in Vue template interpolation (`{{ ENV.X }}`), which previously fell through to the runtime proxy and broke hydration in production builds
