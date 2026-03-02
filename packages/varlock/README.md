# Varlock

[![npm version](https://img.shields.io/npm/v/varlock.svg)](https://www.npmjs.com/package/varlock) [![npm downloads](https://img.shields.io/npm/dm/varlock.svg)](https://www.npmjs.com/package/varlock) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/varlock.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

> AI-safe .env files: Schemas for agents, Secrets for humans.

- 🤖 AI-safe config — agents read your schema, never your secrets
- 🔍 proactive leak scanning via `varlock scan` + git hooks
- 🔏 runtime protection — log redaction and leak prevention
- 🛡️ validation, coercion, type safety w/ IntelliSense
- 🌐 flexible multi-environment management — auto .env.* loading and explicit import
- 🔌 6 secret manager plugins (1Password, Infisical, AWS, Azure, GCP, Bitwarden)

See https://varlock.dev for full docs and examples.

_A sample `.env.schema`_:
```bash
# @currentEnv=$APP_ENV
# ---

# @type=enum(development, staging, production)
APP_ENV=development #sets default value

# API port
# @type=port @example=3000
API_PORT=

# API url including expansion of another env var
# @required @type=url
API_URL=localhost:${API_PORT}

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
# Install as a dependency in a js project
npm install varlock

# OR as standalone CLI via homebrew
brew install dmno-dev/tap/varlock

# OR via cURL
curl -sSfL https://varlock.dev/install.sh | sh -s
```

See the full installation [docs](https://varlock.dev/getting-started/installation/).

## Workflow

Validate your `.env.schema` with:

```bash
varlock load
```

If you need to pass resolved env vars into another process, you can run:

```bash
varlock run -- node script.js
```

Or you can integrate more deeply with one of our [integrations](https://varlock.dev/integrations/javascript/) to get log redaction and leak prevention.

## AI-Safe Config

Your `.env.schema` gives AI agents full context on your config — variable names, types, validation rules, descriptions — without ever exposing secret values. Combined with `varlock scan` to catch leaked secrets in AI-generated code, varlock is purpose-built for the AI era. Learn more in the [AI-safe config guide](https://varlock.dev/guides/ai-tools/).

## @env-spec

Varlock is built on top of @env-spec, a new DSL for attaching a schema and additional functionality to .env files using JSDoc style comments. The @env-spec package contains a parser and info about the spec itself.

- @env-spec [docs](https://varlock.dev/env-spec/overview/)
- @env-spec [RFC](https://github.com/dmno-dev/varlock/discussions/17)

