# @varlock/nuxt-integration

[![npm version](https://img.shields.io/npm/v/@varlock/nuxt-integration.svg)](https://npmx.dev/package/@varlock/nuxt-integration) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/nuxt-integration.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package helps you integrate [varlock](https://varlock.dev) into a [Nuxt](https://nuxt.com) project.

> See [our docs site](https://varlock.dev/integrations/nuxt/) for complete installation and usage instructions.

It is designed as a [Nuxt module](https://nuxt.com/docs/guide/concepts/modules) that adds varlock to both the Vite config and the Nitro server build, so `.env` files are loaded and validated by varlock across dev, build, and the production server.

Compared to the [default Nuxt behavior](https://nuxt.com/docs/guide/going-further/runtime-config), this package provides:

- Validation of your env vars against your `.env.schema`
- Type-generation and type-safe env var access with built-in docs
- Redaction of sensitive values from logs during build and dev time
- Automatic leak prevention of sensitive items at build and runtime
- More flexible multi-env handling

## Installation

```bash
npm install @varlock/nuxt-integration varlock
# or
bun add @varlock/nuxt-integration varlock
```

## Setup

Add the module to your `nuxt.config.ts`:

```ts title="nuxt.config.ts"
export default defineNuxtConfig({
  modules: ['@varlock/nuxt-integration'],
})
```

Then run `varlock init` to set up your `.env.schema` file based on your existing `.env` files.
