# @varlock/doppler-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/doppler-plugin.svg)](https://npmx.dev/package/@varlock/doppler-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/doppler-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

Load secrets from [Doppler](https://www.doppler.com/) into your Varlock configuration.

## Features

- ✅ Fetch secrets from Doppler projects and configs
- ✅ Bulk-load secrets with `dopplerBulk()` via `@setValuesBulk`
- ✅ Service token authentication
- ✅ Efficient caching — single API call shared across all secret lookups
- ✅ Multiple plugin instances for different projects/configs
- ✅ Auto-infer secret names from variable names
- ✅ Helpful error messages with resolution tips

`cacheTtl` is optional and uses the same duration format as varlock `cache()` (e.g. `"5m"`, `"1h"`, `"1d"`, or `"forever"` to cache until manually cleared). Set to `false` (or an empty string) to disable caching.

## Installation

```bash
npm install @varlock/doppler-plugin
```

Or load it directly from your `.env.schema` file:

```env-spec
# @plugin(@varlock/doppler-plugin)
```

## Setup

### 1. Create a Service Token in Doppler

Navigate to your project config in the Doppler dashboard → **Access** → **Service Tokens** → Generate a token.

### 2. Configure your `.env.schema`

```env-spec
# @plugin(@varlock/doppler-plugin)
# @initDoppler(
#   project=my-project,
#   config=dev,
#   serviceToken=$DOPPLER_TOKEN,
#   cacheTtl="1h"
# )
# ---

# @type=dopplerServiceToken @sensitive @internal
DOPPLER_TOKEN=
```

## Usage

### Basic secret fetching

```env-spec
# Secret name defaults to the config item key
DATABASE_URL=doppler()
API_KEY=doppler()

# Or explicitly specify the secret name
STRIPE_SECRET=doppler("STRIPE_SECRET_KEY")
```

### Multiple instances

```env-spec
# @initDoppler(id=dev, project=my-app, config=dev, serviceToken=$DEV_DOPPLER_TOKEN)
# @initDoppler(id=prod, project=my-app, config=prd, serviceToken=$PROD_DOPPLER_TOKEN)
# ---

DEV_DATABASE=doppler(dev, "DATABASE_URL")
PROD_DATABASE=doppler(prod, "DATABASE_URL")
```

### Bulk loading secrets

```env-spec
# @plugin(@varlock/doppler-plugin)
# @initDoppler(project=my-project, config=dev, serviceToken=$DOPPLER_TOKEN)
# @setValuesBulk(dopplerBulk())
# ---

# @type=dopplerServiceToken @sensitive @internal
DOPPLER_TOKEN=

DATABASE_URL=
API_KEY=
REDIS_URL=
```

## Resources

- [Doppler Documentation](https://docs.doppler.com)
- [Service Tokens](https://docs.doppler.com/docs/service-tokens)
- [Doppler API Reference](https://docs.doppler.com/reference)
