# @varlock/cloudflare-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Cloudflare Workers](https://developers.cloudflare.com/workers/) project.

It provides:

- a Vite plugin (`varlockCloudflareVitePlugin`) that wraps `@cloudflare/vite-plugin` with automatic env var injection into miniflare bindings and Cloudflare's secret bindings at runtime
- a SvelteKit-specific Vite plugin (`varlockSvelteKitCloudflarePlugin` at `@varlock/cloudflare-integration/sveltekit`) for projects deploying via `@sveltejs/adapter-cloudflare`
- a `varlock-wrangler` CLI binary — a drop-in replacement for `wrangler` that injects env via named pipe in dev, uploads vars/secrets on deploy, and generates correct types
- a standalone init module (`@varlock/cloudflare-integration/init`) for non-Vite workers
- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive values from logs
- leak prevention in responses

Compared to the base `@varlock/vite-integration`, this package avoids bundling secrets into your worker code. Instead, sensitive values are stored as Cloudflare secrets and non-sensitive values as Cloudflare vars.

See [our docs site](https://varlock.dev/integrations/cloudflare/) for complete installation and usage instructions.
