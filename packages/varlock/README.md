# Varlock

> See https://varlock.dev for docs and examples. 

_A sample `.env.schema`_: 
```bash
# @envFlag=APP_ENV
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

### New flags

```bash
varlock load [--format json] [--env production]
# --exclude-local            Exclude .env.local and .env.[env].local from loading
# --respect-existing-env     Allow ambient process.env to override schema-defined keys

varlock run -- <command>
# --exclude-local            Exclude .env.local and .env.[env].local from loading
# --respect-existing-env     Allow ambient process.env to override schema-defined keys
# --bun-sync-node-env        When running Bun, set NODE_ENV to the resolved @envFlag value
```

- `.env.local` and `.env.[env].local` are included by default. Use `--exclude-local` to disable them.
- By default, ambient `process.env` does not override schema-defined keys. Use `--respect-existing-env` to allow ambient overrides.

#### Notes on using Varlock with Bun

- When running `bun`/`bunx` via `varlock run`, Varlock neutralizes Bun’s dotenv by passing an empty `--env-file` and injects the resolved environment into the child process. Optionally sync `NODE_ENV` with `--bun-sync-node-env`.

Or you can integrate more deeply with one of our [integrations](https://varlock.dev/integrations/javascript/) to get log redaction and leak prevention. 

## @env-spec

Varlock is built on top of @env-spec, a new DSL for attaching a schema and additional functionality to .env files using JSDoc style comments. The @env-spec package contains a parser and info about the spec itself.

- @env-spec [docs](https://varlock.dev/env-spec/overview/) 
- @env-spec [RFC](https://github.com/dmno-dev/varlock/discussions/17)

