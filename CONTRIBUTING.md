PRs are always welcome.

**First, please read our [Code of Conduct](CODE_OF_CONDUCT.md).**

If you have any questions please reach out to us on [Discord](https://chat.dmno.dev) in the #contribute channel.

## Installation

You'll need, at minimum, node 22 and [bun](https://bun.sh) installed.

Then install the dependencies:

```bash
bun install
```

Then build the libraries:

```bash
bun run build:libs
```


## Packages

- [packages/env-spec-parser](./packages/env-spec-parser) - Parser for the @env-spec language
- [packages/varlock](./packages/varlock) - CLI for loading .env files, and library for integration into JS projects
- [packages/varlock-website](./packages/varlock-website) - Docs website for varlock and @env-spec
- [packages/vscode-plugin](./packages/vscode-plugin) - VSCode extension for @env-spec
- [packages/integrations/nextjs](./packages/integrations/nextjs) - Next.js integration for varlock

> See the README.md for each package for more details.


## Debugging

It is often useful to enable source maps in traces during local development.

To do so run `export NODE_OPTIONS=--enable-source-maps` in your active terminal.

## Plugins Development

To develop a plugin, you can use the `@plugin` root decorator to load the plugin from a local `.env.schema` file.

e.g. use `@plugin(./packages/plugins/1password)` instead of a package name like `@plugin(@varlock/1password-plugin)`.

```env-spec
# @plugin(./packages/plugins/1password)
# @initOp(token=$OP_TOKEN, allowAppAuth=true)
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=
```
