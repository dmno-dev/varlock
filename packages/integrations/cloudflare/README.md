# @varlock/cloudflare-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Cloudflare Workers](https://developers.cloudflare.com/workers/) project.

It provides:

- a Vite plugin (`varlockCloudflareVitePlugin`) that works alongside `@cloudflare/vite-plugin` to inject resolved env at runtime via Cloudflare's secret bindings
- a `varlock-wrangler` CLI binary that wraps `wrangler` to automatically upload resolved env vars as secrets and vars on deploy
- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive values from logs
- leak prevention in responses

Compared to the base `@varlock/vite-integration`, this package avoids bundling secrets into your worker code. Instead, sensitive values are stored as Cloudflare secrets and non-sensitive values as Cloudflare vars.

See [our docs site](https://varlock.dev/integrations/cloudflare/) for complete installation and usage instructions.
