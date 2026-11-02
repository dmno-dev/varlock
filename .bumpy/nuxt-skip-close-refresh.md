---
"@varlock/nuxt-integration": patch
---

Stop re-resolving env (and re-triggering auth prompts like 1Password) when the Nuxt dev server shuts down or reloads without an env file change
