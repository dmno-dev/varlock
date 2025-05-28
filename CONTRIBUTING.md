PRs are always welcome. 

**First, please read our [Code of Conduct](CODE_OF_CONDUCT.md).**

If you have any questions please reach out to us on [Discord](https://chat.dmno.dev) in the #contribute channel.

## Installation

You'll need, at minimum, node 22 and pnpm 10+ installed.

We recommend using [fnm](https://github.com/Schniz/fnm) to manage node versions. If you use `fnm` with `corepack` you can run `corepack enable` to enable pnpm and you should be good to go.

Then install the dependencies:

```bash
pnpm install
```

Then build the libraries:

```bash
pnpm build:libs
```


## Packages

- [packages/env-spec-parser](./packages/env-spec-parser) - Parser for the @env-spec language
- [packages/varlock](./packages/varlock) - CLI for loading .env files and applying schemas
- [packages/varlock-website](./packages/varlock-website) - Website for varlock and env-spec
- [packages/vscode-plugin](./packages/vscode-plugin) - VSCode extension for env-spec

> See the README.md for each package for more details. 



