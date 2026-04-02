---
"varlock": patch
"@varlock/vite-integration": patch
---

Improve invalid config handling in CLI and Vite integration

- `varlock load --format json-full` now outputs partial JSON (with `errors` field) even when validation fails, enabling consumers to access sources and valid config items
- Vite plugin gracefully handles invalid config in dev mode: shows error page and automatically recovers when the config is fixed
- Vite build output now includes specific error details when config validation fails
