<p align="center">
  <a href="https://varlock.dev" target="_blank" rel="noopener noreferrer">
    <img src="/packages/varlock-website/public/github-readme-banner.png" alt="Varlock banner">
  </a>
</p>
<br/>
<p align="center">
  <a href="https://npmjs.com/package/varlock"><img src="https://img.shields.io/npm/v/varlock.svg" alt="npm package"></a>
  <a href="/LICENSE.md"><img src="https://img.shields.io/npm/l/varlock.svg" alt="license"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/varlock.svg" alt="node compatibility"></a>
  <a href="https://github.com/dmno-dev/varlock/actions/workflows/test.yaml"><img src="https://img.shields.io/github/actions/workflow/status/dmno-dev/varlock/test.yaml?style=flat&logo=github&label=CI" alt="build status"></a>
  <a href="https://chat.dmno.dev"><img src="https://img.shields.io/badge/chat-discord-5865F2?style=flat&logo=discord" alt="discord chat"></a>
</p>
<br/>

## Varlock
> add declarative schema to your .env files using @env-spec decorator comments

- 🛡️ validation, coercion, type safety w/ Intellisense
- 🔏 protection for sensitive config values (log redaction, leak prevention)
- 🌐 flexible multi-environment management
- 💫 composition of values, functions, load from external sources

Your `.env.schema` is a declarative schema of your environment variables that lives within version control, so it will never be out of sync.

```bash
# @defaultSensitive=false @defaultRequired=infer @envFlag=APP_ENV
# ---
# our environment flag, will control automatic loading of `.env.xxx` files
# @type=enum(development, preview, production, test
APP_ENV=development # default value, can override

# API port
# @type=port @example=3000
API_PORT=

# API url including _expansion_ referencing another env var
# @required @type=url
API_URL=http://localhost:${API_PORT}

# API key with validation, securely fetched from 1Password
# @required @sensitive @type=string(startsWith=sk-)
OPENAI_API_KEY=exec('op read "op://api-prod/openai/api-key"')

# Non-secret value, included directly
# @type=url
SOME_SERVICE_API_URL=https://api.someservice.com
```

## Installation

You can get started with varlock by installing the CLI:

```bash
# Run the installation wizard, which will install as a dependency in a JavaScript project
npx varlock init

# Or install as standalone binary
brew install dmno-dev/tap/varlock # via homebrew
curl -sSfL https://varlock.dev/install.sh | sh -s # via cURL

# Or use the official Docker image
docker pull ghcr.io/dmno-dev/varlock:latest
```
See the full [installation docs](https://varlock.dev/getting-started/installation/) or the [Docker guide](https://varlock.dev/guides/docker/) for more information.


## Workflow

Validate your `.env.schema` and pretty print your environment variables with:

```bash
varlock load
```

If you need to pass resolved env vars into another process, you can run:

```bash
varlock run -- python script.py
```

Or you can integrate more deeply with one of our [integrations](https://varlock.dev/integrations/javascript/) to enable security guardrails, like log redaction and leak prevention.

## @env-spec

Varlock is built on top of @env-spec, a new DSL for attaching a schema and additional functionality to .env files using JSDoc style comments. The @env-spec package contains a parser and info about the spec itself.

- @env-spec [docs](https://varlock.dev/env-spec/overview/)
- @env-spec [RFC](https://github.com/dmno-dev/varlock/discussions/17)


## Published Packages
| Package | Published listing page |
| --- | --- |
| [varlock](packages/varlock) | [![npm version](https://img.shields.io/npm/v/varlock.svg)](https://npmjs.com/package/varlock) |
| [@varlock/nextjs-integration](packages/integrations/nextjs) | [![npm version](https://img.shields.io/npm/v/@varlock/nextjs-integration.svg)](https://npmjs.com/package/@varlock/nextjs-integration) |
| [@varlock/vite-integration](packages/integrations/vite) | [![npm version](https://img.shields.io/npm/v/@varlock/vite-integration.svg)](https://npmjs.com/package/@varlock/vite-integration) |
| [@env-spec/parser](packages/env-spec-parser) | [![npm version](https://img.shields.io/npm/v/@env-spec/parser.svg)](https://npmjs.com/package/@env-spec/parser) |
| [@env-spec VSCode extension](packages/vscode-plugin) | [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=varlock.env-spec-language), [Open VSX Registry](https://open-vsx.org/extension/varlock/env-spec-language) |
| [varlock Docker image](Dockerfile) | [GitHub Container Registry](https://github.com/orgs/dmno-dev/packages/container/package/varlock) |

## Development & Contribution

See [CONTRIBUTING.md](CONTRIBUTING.md) for more information.
