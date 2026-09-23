# @varlock/penv-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/penv-plugin.svg)](https://npmx.dev/package/@varlock/penv-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/penv-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

Load secrets from [penv.cloud](https://penv.cloud) into your Varlock configuration.

## Features

- Fetch secrets from a penv.cloud project, in the current environment or any other
- Reads the same `@penv=org/project` header and `penv(...)` addresses as the [penv CLI](https://github.com/penvhq/penvhq), so one `.env.schema` works with both tools
- Bulk-load an environment with `penvBulk()` via `@setValuesBulk`
- Machine token authentication
- One request per environment per load, shared by every key that reads it
- HTTPS only, redirects refused, and tokens never appear in errors

`cacheTtl` is optional and uses the same duration format as varlock `cache()` (e.g. `"5m"`, `"1h"`, `"1d"`, or `"forever"`). Set it to `false` (or an empty string) to disable caching.

## Installation

```bash
npm install @varlock/penv-plugin
```

Or load it directly from your `.env.schema` file:

```env-spec
# @plugin(@varlock/penv-plugin)
```

## Setup

### 1. Create a machine token

Create a machine token for the project in the penv.cloud console, scoped to the environments this app reads. It starts with `pck_`.

### 2. Configure your `.env.schema`

```env-spec
# @plugin(@varlock/penv-plugin)
# @penv=acme/api
# @initPenv(environment=$APP_ENV, token=$PENV_TOKEN)
# @currentEnv=$APP_ENV
# ---

# @type=enum(development, staging, production)
APP_ENV=development

# @type=penvToken
PENV_TOKEN=
```

`@penv=` names the org and project. `environment` defaults to `development`; pointing it at your `@currentEnv` item keeps them in step.

| `@initPenv()` option | Default |
|---|---|
| `environment` | `development` |
| `token` | `$PENV_TOKEN` |
| `url` | `https://penv.cloud`; a self-hosted or proxied API root |
| `org`, `project` | from `@penv=` |
| `cacheTtl` | no cache |

## Usage

### Basic secret fetching

```env-spec
# The key it is on, in the current environment
DATABASE_URL=penv()

# Another key name
STRIPE_SECRET_KEY=penv(STRIPE_KEY)

# Another environment, project or org
PROD_DATABASE_URL=penv(production/DATABASE_URL)
BILLING_TOKEN=penv(billing/production/API_TOKEN)
SHARED_SENTRY_DSN=penv(acme-shared/observability/production/SENTRY_DSN)
```

### Bulk loading

```env-spec
# @plugin(@varlock/penv-plugin)
# @penv=acme/api
# @initPenv(environment=$APP_ENV, token=$PENV_TOKEN)
# @setValuesBulk(penvBulk())
# ---

# @type=penvToken
PENV_TOKEN=

DATABASE_URL=
STRIPE_SECRET_KEY=
REDIS_URL=
```

`penvBulk(production)` loads another environment.

## Using the same schema with the penv CLI

The penv CLI reads `@penv=` and `penv(...)` natively and ignores `@plugin` and `@initPenv`:

```bash
penv run -- npm run dev        # penv CLI
varlock run -- npm run dev     # varlock with this plugin
```

## Resources

- [penv.cloud](https://penv.cloud)
- [penv CLI](https://github.com/penvhq/penvhq)
- [penv.cloud API](https://github.com/penvhq/penvhq/blob/main/docs/Cloud-API.md)
