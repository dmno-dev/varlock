---
"varlock": minor
"@varlock/vite-integration": minor
---

new @excludeSensitiveFromInjectedEnv root setting keeps @sensitive values out of the SSR bundle injected by resolved-env mode; ENV falls back to runtime process.env for excluded items
