# @varlock/vite-integration

This package helps you integrate [varlock](https://varlock.dev) into a [Vite](https://vite.dev)-powered project.

It is designed as a [Vite plugin](https://vite.dev/guide/using-plugins.html), which will override Vite's default `.env` file loading logic, and instead use varlock.

Compared to the default Vite behavior, this package provides:

- validation of your env vars against your `.env.schema`
- type-generation and type-safe env var access with built-in docs
- redaction of sensitive from logs during build time
- more flexible multi-env handling, rather than relying on the `--mode` flag

See [our docs site](https://varlock.dev/integrations/vite/) for complete installation and usage instructions.

Some web frameworks use vite and have their own plugins to enable very complex client/server hybrid rendering, or complex build processes. This plugin is designed to work with simple vanilla Vite projects, and complex framework powered projects. While this plugin should work with most frameworks, so far it has specifcally been tested with:

- [React Router](https://reactrouter.com/)
- [Qwik](http://qwik.dev/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Astro](https://astro.build/)* (please use the [Astro integration](https://varlock.dev/integrations/astro/))
