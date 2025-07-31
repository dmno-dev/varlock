# @varlock/vite-integration

This package helps you integrate [varlock](https://varlock.dev) into an [Astro](https://astro.build) project.

> See [our docs site](https://varlock.dev/integrations/astro/) for complete installation and usage instructions.

It is designed as an [Astro integration](https://docs.astro.build/en/guides/integrations-guide/), which will override Astro's default `.env` file loading logic (powered by Vite), to instead use varlock.

Compared to the [default Astro behavior](https://docs.astro.build/en/guides/environment-variables/), this package provides:

- Validation of your env vars against your `.env.schema`
- Type-generation and type-safe env var access with built-in docs
- Redaction of sensitive from logs during build time
- Automatic leak prevention of sensitive items at build and runtime
- More flexible multi-env handling, rather than relying on the `--mode` flag

While some of these features are similar to what can be accomplished via [`astro:env`](https://docs.astro.build/en/guides/environment-variables/#type-safe-environment-variables), this integration provides additional security features and more flexible multi-env handling.

- Facilitates loading and composing multiple `.env` files
- You can use validated env vars right away within your `astro.config.*` file
- Facilitates setting values and handling multiple environments, not just setting defaults
- More data types and options available
- Leak detection, log redaction, and more security guardrails
- Works with various adapters and platforms to make your resolved config available
