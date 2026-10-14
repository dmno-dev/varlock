# @varlock/alchemy-integration

[![npm version](https://img.shields.io/npm/v/@varlock/alchemy-integration.svg)](https://npmx.dev/package/@varlock/alchemy-integration) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/alchemy-integration.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

Use [varlock](https://varlock.dev) as the secret manager for an [Alchemy](https://alchemy.run) stack.

> See [our docs site](https://varlock.dev/integrations/alchemy/) for complete installation and usage instructions.

It is a [secret provider](https://alchemy.run/environments/secret-providers/) for Alchemy's `secrets` option (`Alchemy.Stack(name, { secrets: varlock() })`, alchemy 2.0.0-beta.80 or later) and:

- resolves and validates your `.env.schema` (plugins, `.env` files, `@currentEnv`) before alchemy builds any provider, and makes the values the stack's Effect `Config` source
- exposes schema items as typed Worker bindings you spread into a resource's `env`, with `@sensitive` items uploaded as secrets; a `bindingsFilter` (`"!#deploy"`) or the root/service split keeps deploy credentials out
- includes the `__VARLOCK_ENV` blob so `@varlock/cloudflare-integration/init` gives the Worker log redaction, leak detection, and a typed `ENV`
- supports one schema per service (`varlockServices`) for monorepos with several Workers behind one `alchemy.run.ts`
