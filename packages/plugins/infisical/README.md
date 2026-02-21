# @varlock/infisical-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/infisical-plugin.svg)](https://www.npmjs.com/package/@varlock/infisical-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/infisical-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

Load secrets from [Infisical](https://infisical.com/) into your Varlock configuration using declarative instructions in your `.env.schema` files.

## Features

- ✅ Fetch secrets from Infisical projects and environments
- ✅ Bulk-load secrets with `infisicalBulk()` via `@setValuesBulk`
- ✅ Universal Auth with Client ID and Client Secret
- ✅ Support for custom Infisical instances (self-hosted)
- ✅ Secret paths and hierarchical organization
- ✅ Filter secrets by tag
- ✅ Multiple plugin instances for different projects/environments
- ✅ Helpful error messages with resolution tips

## Installation

Install the plugin package:

```bash
npm install @varlock/infisical-plugin
# or
pnpm add @varlock/infisical-plugin
# or
yarn add @varlock/infisical-plugin
```

Alternatively, load it directly in your `.env.schema` file with a version specifier:

```env-spec
# @plugin(@varlock/infisical-plugin@0.1.0)
```

## Setup

### 1. Create a Machine Identity in Infisical

1. Navigate to your Infisical project settings
2. Go to **Access Control** → **Machine Identities**
3. Click **Create Identity** and select **Universal Auth**
4. Save the **Client ID** and **Client Secret**
5. Grant the identity access to your project and environment

For detailed instructions, see [Infisical Machine Identities documentation](https://infisical.com/docs/documentation/platform/identities/machine-identities).

### 2. Initialize the Plugin

Add the plugin to your `.env.schema` file:

```env-spec title=".env.schema"
# @plugin(@varlock/infisical-plugin)
# @initInfisical(
#   projectId=your-project-id,
#   environment=dev,
#   clientId=$INFISICAL_CLIENT_ID,
#   clientSecret=$INFISICAL_CLIENT_SECRET
# )
# ---
# @type=infisicalClientId
INFISICAL_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
INFISICAL_CLIENT_SECRET=
```

#### Configuration Parameters

- **`projectId`** (required): Your Infisical project ID
- **`environment`** (required): Environment name (e.g., `dev`, `staging`, `production`)
- **`clientId`** (required): Universal Auth Client ID
- **`clientSecret`** (required): Universal Auth Client Secret
- **`siteUrl`** (optional): Custom Infisical instance URL (defaults to `https://app.infisical.com`)
- **`secretPath`** (optional): Default secret path for all secrets (defaults to `/`)
- **`id`** (optional): Instance identifier for using multiple instances

## Usage

### Basic Secret Fetching

Once initialized, use the `infisical()` resolver to fetch secrets:

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(projectId=my-project, environment=production, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET)
# ---
# Secret name defaults to the config item key
DATABASE_URL=infisical()
API_KEY=infisical()

# Or explicitly specify the secret name
STRIPE_SECRET=infisical("STRIPE_SECRET_KEY")
```

When called without arguments, `infisical()` automatically uses the config item key as the secret name in Infisical. This provides a convenient convention-over-configuration approach.

### Using Secret Paths

Organize secrets with paths:

```env-spec
# Default path for all secrets
# @initInfisical(projectId=my-project, environment=production, clientId=$ID, clientSecret=$SECRET, secretPath=/production/app)
# ---
DB_PASSWORD=infisical("DB_PASSWORD")  # Fetches from /production/app/DB_PASSWORD

# Or specify path per secret
# @initInfisical(projectId=my-project, environment=production, clientId=$ID, clientSecret=$SECRET)
# ---
DB_PASSWORD=infisical("DB_PASSWORD", "/database")
API_KEY=infisical("API_KEY", "/api")
```

### Multiple Instances

Use multiple Infisical projects or environments:

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(id=dev, projectId=dev-project, environment=development, clientId=$DEV_CLIENT_ID, clientSecret=$DEV_CLIENT_SECRET)
# @initInfisical(id=prod, projectId=prod-project, environment=production, clientId=$PROD_CLIENT_ID, clientSecret=$PROD_CLIENT_SECRET)
# ---
# @type=infisicalClientId
DEV_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
DEV_CLIENT_SECRET=
# @type=infisicalClientId
PROD_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
PROD_CLIENT_SECRET=

DEV_DATABASE=infisical(dev, "DATABASE_URL")
PROD_DATABASE=infisical(prod, "DATABASE_URL")
```

### Bulk Loading Secrets

Use `infisicalBulk()` with `@setValuesBulk` to load all secrets from a project environment at once:

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(projectId=my-project, environment=dev, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET)
# @setValuesBulk(infisicalBulk())
# ---
# @type=infisicalClientId
INFISICAL_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
INFISICAL_CLIENT_SECRET=

# These will be populated from Infisical
API_KEY=
DB_PASSWORD=
```

Filter by path or tag:

```env-spec
# Load secrets from a specific path
# @setValuesBulk(infisicalBulk(path="/database"))

# Load secrets with a specific tag
# @setValuesBulk(infisicalBulk(tag="backend"))

# Combine path and tag
# @setValuesBulk(infisicalBulk(path="/production", tag="app"))

# With a named instance
# @setValuesBulk(infisicalBulk(prod, path="/database"))
```

### Self-Hosted Infisical

For self-hosted Infisical instances, specify the `siteUrl`:

```env-spec
# @initInfisical(
#   projectId=my-project,
#   environment=production,
#   clientId=$CLIENT_ID,
#   clientSecret=$CLIENT_SECRET,
#   siteUrl=https://infisical.mycompany.com
# )
```

## API Reference

### `@initInfisical()`

Root decorator to initialize an Infisical plugin instance.

**Parameters:**
- `projectId: string` - Infisical project ID
- `environment: string` - Environment name
- `clientId: string` - Universal Auth Client ID
- `clientSecret: string` - Universal Auth Client Secret
- `siteUrl?: string` - Custom Infisical instance URL
- `secretPath?: string` - Default secret path
- `id?: string` - Instance identifier (static)

### `infisical()`

Resolver function to fetch secret values.

**Signatures:**
- `infisical()` - Fetch using config item key as secret name from default instance
- `infisical(secretName)` - Fetch specific secret from default instance
- `infisical(secretName, secretPath)` - Fetch with custom path from default instance
- `infisical(instanceId, secretName)` - Fetch from named instance
- `infisical(instanceId, secretName, secretPath)` - Full form with named instance

**Returns:** The secret value as a string

**Note:** When called without arguments, the config item key is automatically used as the secret name in Infisical. For example, `DATABASE_URL=infisical()` will fetch a secret named `DATABASE_URL` from Infisical.

### `infisicalBulk()`

Resolver function to bulk-load all secrets from an Infisical project environment. Intended for use with `@setValuesBulk`.

**Signatures:**
- `infisicalBulk()` - Load all secrets from default instance
- `infisicalBulk(path="/folder")` - Load secrets from a specific path
- `infisicalBulk(tag="some-tag")` - Load secrets filtered by tag
- `infisicalBulk(path="/folder", tag="some-tag")` - Combine path and tag
- `infisicalBulk(instanceId, path="/folder")` - Load from a named instance with path

**Key/value args:**
- `path` (optional): Secret path to fetch from (overrides default path from `@initInfisical`)
- `tag` (optional): Tag slug to filter secrets by

**Returns:** JSON string of `{ secretKey: secretValue }` pairs

## Data Types

### `infisicalClientId`

Client ID for Universal Auth (non-sensitive).

### `infisicalClientSecret`

Client Secret for Universal Auth (marked as sensitive).

## Error Handling

The plugin provides helpful error messages:

- **Secret not found**: Includes console link and verification steps
- **Access denied**: Suggests checking machine identity permissions
- **Authentication failed**: Prompts to verify credentials
- **General errors**: Provides context-specific troubleshooting tips

## Example Configurations

### Development Setup with Auto-Named Secrets

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(projectId=dev-app, environment=dev, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET)
# ---
# @type=infisicalClientId
INFISICAL_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
INFISICAL_CLIENT_SECRET=

# Secret names automatically match config keys
DATABASE_URL=infisical()
REDIS_URL=infisical()
STRIPE_KEY=infisical()
```

### Production with Path Organization

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(
#   projectId=prod-app,
#   environment=production,
#   clientId=$INFISICAL_CLIENT_ID,
#   clientSecret=$INFISICAL_CLIENT_SECRET,
#   secretPath=/production
# )
# ---
# Database secrets at /production/database
DB_HOST=infisical("DB_HOST", "/database")
DB_PASSWORD=infisical("DB_PASSWORD", "/database")

# API keys at /production/api
STRIPE_KEY=infisical("STRIPE_KEY", "/api")
SENDGRID_KEY=infisical("SENDGRID_KEY", "/api")
```

### Bulk Loading with Tags

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(projectId=my-app, environment=production, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET)
# @setValuesBulk(infisicalBulk(tag="backend"))
# ---
# @type=infisicalClientId
INFISICAL_CLIENT_ID=
# @type=infisicalClientSecret @sensitive
INFISICAL_CLIENT_SECRET=

DATABASE_URL=
REDIS_URL=
API_KEY=
```

### Multi-Region Setup

```env-spec
# @plugin(@varlock/infisical-plugin)
# @initInfisical(id=us, projectId=app-us, environment=production, clientId=$US_CLIENT_ID, clientSecret=$US_CLIENT_SECRET)
# @initInfisical(id=eu, projectId=app-eu, environment=production, clientId=$EU_CLIENT_ID, clientSecret=$EU_CLIENT_SECRET)
# ---
US_DATABASE=infisical(us, "DATABASE_URL")
EU_DATABASE=infisical(eu, "DATABASE_URL")
```

## Resources

- [Infisical Documentation](https://infisical.com/docs)
- [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
- [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth)
- [Infisical Node SDK](https://infisical.com/docs/sdks/languages/node)
