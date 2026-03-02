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
> AI-safe .env files: Schemas for agents, Secrets for humans.

- 🤖 AI-safe config — agents read your schema, never your secrets
- 🔍 proactive leak scanning via `varlock scan` + git hooks
- 🔏 runtime protection — log redaction and leak prevention
- 🛡️ validation, coercion, type safety w/ IntelliSense
- 🌐 flexible multi-environment management — auto .env.* loading and explicit import
- 🔌 6 secret manager plugins (1Password, Infisical, AWS, Azure, GCP, Bitwarden)

Unlike .env.example, **your .env.schema is a single source of truth**, built for collaboration, that will never be out of sync.

```bash
# @defaultSensitive=false @defaultRequired=infer @currentEnv=$APP_ENV
# ---
# our environment flag, will control automatic loading of `.env.xxx` files
# @type=enum(development, preview, production, test
APP_ENV=development # default value, can override

# @type=port
API_PORT=8080 # non-sensitive values can be set directly

# API url including _expansion_ referencing another env var
# @type=url
API_URL=http://localhost:${API_PORT}

# sensitive api key, with extra validation
# @required @sensitive @type=string(startsWith=sk-)
OPENAI_API_KEY=
```

**Flexible plugin system**: adds new decorators, functions, types - enables secure declarative secret loading.

```bash
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=

# Fetch secrets using 1Password secret references
DB_PASS=op(op://my-vault/database-password/password)
API_KEY=op(op://api-vault/stripe/api-key)
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

In many cases you can use our [drop-in integrations](https://varlock.dev/integrations/javascript/) for seamless experience - with additional security guardrails, like log redaction and leak prevention.

## AI-Safe Config

Your `.env.schema` gives AI agents full context on your config — variable names, types, validation rules, descriptions — without ever exposing secret values. Combined with `varlock scan` to catch leaked secrets in AI-generated code, varlock is purpose-built for the AI era. Learn more in the [AI-safe config guide](https://varlock.dev/guides/ai-tools/).

## @env-spec

Varlock is built on top of @env-spec, a new DSL for attaching a schema and additional functionality to .env files using JSDoc style comments. The @env-spec package contains a parser and info about the spec itself.

- @env-spec [docs](https://varlock.dev/env-spec/overview/)
- @env-spec [RFC](https://github.com/dmno-dev/varlock/discussions/17)


## Published Packages

### Core
| Package | Published listing page |
| --- | --- |
| [varlock](packages/varlock) | [![npm version](https://img.shields.io/npm/v/varlock.svg)](https://npmjs.com/package/varlock) |
| [@env-spec/parser](packages/env-spec-parser) | [![npm version](https://img.shields.io/npm/v/@env-spec/parser.svg)](https://npmjs.com/package/@env-spec/parser) |
| [@env-spec VSCode extension](packages/vscode-plugin) | [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=varlock.env-spec-language), [Open VSX Registry](https://open-vsx.org/extension/varlock/env-spec-language) |
| [varlock Docker image](Dockerfile) | [GitHub Container Registry](https://github.com/orgs/dmno-dev/packages/container/package/varlock) |

### Plugins
| Package | Published listing page |
| --- | --- |
| [@varlock/1password-plugin](packages/plugins/1password) | [![npm version](https://img.shields.io/npm/v/@varlock/1password-plugin.svg)](https://npmjs.com/package/@varlock/1password-plugin) |
| [@varlock/aws-secrets-plugin](packages/plugins/aws-secrets) | [![npm version](https://img.shields.io/npm/v/@varlock/aws-secrets-plugin.svg)](https://npmjs.com/package/@varlock/aws-secrets-plugin) |
| [@varlock/azure-key-vault-plugin](packages/plugins/azure-key-vault) | [![npm version](https://img.shields.io/npm/v/@varlock/azure-key-vault-plugin.svg)](https://npmjs.com/package/@varlock/azure-key-vault-plugin) |
| [@varlock/bitwarden-plugin](packages/plugins/bitwarden) | [![npm version](https://img.shields.io/npm/v/@varlock/bitwarden-plugin.svg)](https://npmjs.com/package/@varlock/bitwarden-plugin) |
| [@varlock/google-secret-manager-plugin](packages/plugins/google-secret-manager) | [![npm version](https://img.shields.io/npm/v/@varlock/google-secret-manager-plugin.svg)](https://npmjs.com/package/@varlock/google-secret-manager-plugin) |
| [@varlock/infisical-plugin](packages/plugins/infisical) | [![npm version](https://img.shields.io/npm/v/@varlock/infisical-plugin.svg)](https://npmjs.com/package/@varlock/infisical-plugin) |

### Framework Integrations
| Package | Published listing page |
| --- | --- |
| [@varlock/astro-integration](packages/integrations/astro) | [![npm version](https://img.shields.io/npm/v/@varlock/astro-integration.svg)](https://npmjs.com/package/@varlock/astro-integration) |
| [@varlock/nextjs-integration](packages/integrations/nextjs) | [![npm version](https://img.shields.io/npm/v/@varlock/nextjs-integration.svg)](https://npmjs.com/package/@varlock/nextjs-integration) |
| [@varlock/vite-integration](packages/integrations/vite) | [![npm version](https://img.shields.io/npm/v/@varlock/vite-integration.svg)](https://npmjs.com/package/@varlock/vite-integration) |


## MCP Servers
| MCP Server | Link | URL |
| --- | --- | --- |
| Varlock Docs (HTTP) | [Installation](https://varlock.dev/guides/mcp/#docs-mcp) | https://docs.mcp.varlock.dev/mcp |
| Varlock Docs (SSE) | [Installation](https://varlock.dev/guides/mcp/#docs-mcp) | https://docs.mcp.varlock.dev/sse |

## Examples
Examples of integrating varlock in various frameworks and situations can be found in the [Varlock examples repo](https://github.com/dmno-dev/varlock-examples)

## Development & Contribution

See [CONTRIBUTING.md](CONTRIBUTING.md) for more information.
