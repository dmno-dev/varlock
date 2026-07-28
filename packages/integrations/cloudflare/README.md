# @varlock/cloudflare-integration

[![npm version](https://img.shields.io/npm/v/@varlock/cloudflare-integration.svg)](https://npmx.dev/package/@varlock/cloudflare-integration) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/cloudflare-integration.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package helps you integrate [varlock](https://varlock.dev) into a [Cloudflare Workers](https://developers.cloudflare.com/workers/) project.

It provides:

- a Vite plugin (`varlockCloudflareVitePlugin`) that wraps `@cloudflare/vite-plugin` with automatic env var injection into miniflare bindings and Cloudflare's secret bindings at runtime, and auto-detects SvelteKit (projects using `@sveltejs/adapter-cloudflare`) to apply the right injection strategy without extra config
- a `varlock-wrangler` CLI binary — a drop-in replacement for `wrangler` that injects env via named pipe in dev, uploads vars/secrets on deploy, and generates correct types
- a standalone init module (`@varlock/cloudflare-integration/init`) for non-Vite workers
- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive values from logs
- leak prevention in responses

Compared to the base `@varlock/vite-integration`, this package avoids bundling secrets into your worker code. Instead, sensitive values are stored as Cloudflare secrets and non-sensitive values as Cloudflare vars.

See [our docs site](https://varlock.dev/integrations/cloudflare/) for complete installation and usage instructions.
