# @varlock/vite-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Vite](https://vite.dev) project.

It is designed as a [Vite plugin](https://vite.dev/guide/using-plugins.html), which will override Vite's default `.env` file loading logic, and instead use varlock.

Compared to the default Vite behavior, this package provides:

- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive from logs during build time
- more flexible multi-env handling, rather than relying on the `--mode` flag

See [our docs site](https://varlock.dev/integrations/vite/) for complete installation and usage instructions.

> ⚠️ This is meant to be used in projects that are using Vite directly. For frameworks that use Vite under the hood, you may need a specific integration for it.
