# @varlock/nextjs-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Next.js](https://nextjs.org) project.

It is designed as a drop-in replacement for [`@next/env`](https://www.npmjs.com/package/@next/env), which is the internal package that Next.js uses to load `.env` files, as well as a small plugin for your `next.config.*` file that enables additional security features.

Compared to the default `@next/env` behavior, this package provides:

- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive values from application logs
- leak detection and prevention, both at build and runtime
- more flexible multi-env handling - you can load env-specific files other than `.env.development`/`.env.production`

See [our docs site](https://varlock.dev/integrations/nextjs/) for complete installation and usage instructions.


