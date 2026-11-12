---
varlock: minor
"@varlock/vite-integration": patch
"@varlock/nextjs-integration": patch
"@varlock/astro-integration": major
"@varlock/nuxt-integration": major
---

Add the `@publicDynamicFilter` root decorator to choose which public+dynamic values are delivered to client code, e.g. `@publicDynamicFilter="#browser"`. Values it does not select stay on the server: they are left out of `getPublicDynamicEnv()`, browser hydration, and the client key list. The Astro and Nuxt integrations now only inject their `/__varlock/public-env` route automatically when the schema sets it; set `publicDynamicEndpoint: true` to keep serving every public+dynamic value.
