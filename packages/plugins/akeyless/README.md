# @varlock/akeyless-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/akeyless-plugin.svg)](https://www.npmjs.com/package/@varlock/akeyless-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/akeyless-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [Akeyless Platform](https://www.akeyless.io/) into your configuration.

## Features

- **API Key authentication** - Simple access_id + access_key authentication
- **Static secrets** - Fetch static (key/value) secrets
- **Dynamic secrets** - Fetch on-demand generated credentials (database, cloud, etc.)
- **Rotated secrets** - Fetch auto-rotated credentials
- **JSON key extraction** from secrets using `#` syntax or named `key` parameter
- **Path prefixing** with `pathPrefix` option for organized secret management
- **Gateway support** - Use a self-hosted Akeyless Gateway via custom `apiUrl`
- **Auto-infer secret name** from environment variable names
- Support for multiple Akeyless instances
- Automatic token caching and renewal
- Response caching for deduplicating concurrent fetches
- Lightweight implementation using REST API (no heavy SDK dependencies)

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/akeyless-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/akeyless-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/akeyless-plugin@1.2.3)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initAkeyless` root decorator.

### API Key authentication

The simplest auth method uses an API Key (Access ID + Access Key):

```env-spec
# @plugin(@varlock/akeyless-plugin)
# @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY)
# ---

# @type=akeylessAccessId
AKEYLESS_ACCESS_ID=
# @type=akeylessAccessKey @sensitive
AKEYLESS_ACCESS_KEY=
```

You would then need to inject these env vars using your CI/CD system or set them locally.

### Using an Akeyless Gateway

If you are running a self-hosted [Akeyless Gateway](https://docs.akeyless.io/docs/api-gateway), provide the gateway URL via `apiUrl`:

```env-spec
# @initAkeyless(
#   accessId=$AKEYLESS_ACCESS_ID,
#   accessKey=$AKEYLESS_ACCESS_KEY,
#   apiUrl="https://gateway.example.com:8080"
# )
```

### Multiple instances

If you need to connect to multiple Akeyless instances, register named instances:

```env-spec
# @initAkeyless(id=prod, accessId=$PROD_ACCESS_ID, accessKey=$PROD_ACCESS_KEY)
# @initAkeyless(id=dev, accessId=$DEV_ACCESS_ID, accessKey=$DEV_ACCESS_KEY)
```

## Reading secrets

This plugin introduces the `akeyless()` function to fetch secret values from Akeyless.

### Static secrets

Static secrets are simple key/value pairs. This is the default secret type.

```env-spec title=".env.schema"
# @plugin(@varlock/akeyless-plugin)
# @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY)
# ---

# Fetch a static secret by its full path
DB_PASSWORD=akeyless("/MyApp/DB_PASSWORD")

# Extract a JSON key from a static secret
DB_HOST=akeyless("/MyApp/DBConfig#host")

# Or use named key parameter
DB_PORT=akeyless("/MyApp/DBConfig", key="port")

# If using multiple instances
PROD_SECRET=akeyless(prod, "/MyApp/Secret")
DEV_SECRET=akeyless(dev, "/MyApp/Secret")
```

### Path prefixing

Use `pathPrefix` to automatically prefix all secret paths:

```env-spec
# @initAkeyless(accessId=$AKEYLESS_ACCESS_ID, accessKey=$AKEYLESS_ACCESS_KEY, pathPrefix="/MyApp")
# ---

# Fetches from "/MyApp/DB_PASSWORD"
DB_PASSWORD=akeyless("DB_PASSWORD")

# Auto-infer also uses the prefix: fetches from "/MyApp/API_KEY"
API_KEY=akeyless()
```

### Dynamic secrets

Dynamic secrets generate on-demand credentials (e.g., temporary database credentials, cloud access tokens). Use the `type=dynamic` parameter:

```env-spec
# Fetch entire dynamic secret as JSON
DB_CREDENTIALS=akeyless("/MyApp/DynamicDBSecret", type=dynamic)

# Extract specific keys from the dynamic secret response
DB_USER=akeyless("/MyApp/DynamicDBSecret#user", type=dynamic)
DB_PASS=akeyless("/MyApp/DynamicDBSecret#password", type=dynamic)
```

Multiple items referencing the same secret path are cached — only one API call is made.

### Rotated secrets

Rotated secrets are auto-rotated credentials. Use the `type=rotated` parameter:

```env-spec
# Fetch entire rotated secret as JSON
DB_ROTATED_CREDS=akeyless("/MyApp/RotatedDBPassword", type=rotated)

# Extract individual keys
DB_USER=akeyless("/MyApp/RotatedDBPassword#user", type=rotated)
DB_PASS=akeyless("/MyApp/RotatedDBPassword#password", type=rotated)
```

---

## Reference

### Root decorators

#### `@initAkeyless()`

Initialize an Akeyless plugin instance.

**Parameters:**

- `accessId: string` (required) - Akeyless Access ID (starts with `p-` for API Key auth)
- `accessKey: string` (required) - Akeyless Access Key
- `apiUrl?: string` - Akeyless API URL (defaults to `https://api.akeyless.io`). Use this for self-hosted Akeyless Gateway.
- `pathPrefix?: string` - Prefix automatically prepended to all secret paths
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `akeyless()`

Fetch a secret from Akeyless.

**Signatures:**

- `akeyless()` - Uses the item key (variable name) as the secret name
- `akeyless(secretName)` - Fetch by explicit secret path
- `akeyless(instanceId, secretName)` - Fetch from a specific instance
- `akeyless("path#key")` - Extract a JSON key using `#` syntax
- `akeyless(secretName, key="field")` - Extract a JSON key using named parameter
- `akeyless(secretName, type=dynamic)` - Fetch a dynamic secret
- `akeyless(secretName, type=rotated)` - Fetch a rotated secret

**Secret types:**

- `static` (default) - Simple key/value secrets. If the value is JSON, use `#KEY` or `key=` to extract individual keys.
- `dynamic` - On-demand generated credentials. Returns JSON by default, or extract a specific key.
- `rotated` - Auto-rotated credentials. Returns JSON by default, or extract a specific key.

**Caching:** Multiple items referencing the same secret path and type share a single API call.

### Data Types

- `akeylessAccessId` - Akeyless Access ID (validates `p-` prefix)
- `akeylessAccessKey` - Akeyless Access Key (sensitive)

---

## Akeyless Setup

### Create an API Key

1. Log in to the [Akeyless Console](https://console.akeyless.io)
2. Go to **Auth Methods** → **New** → **API Key**
3. Save the generated **Access ID** and **Access Key**

### Create a Static Secret

```bash
# Using the Akeyless CLI
akeyless create-secret --name "/MyApp/DB_PASSWORD" --value "supersecret"

# Or via the Console: Secrets & Keys → New → Static Secret
```

### Set Up Access Permissions

1. Go to **Access Roles** in the Akeyless Console
2. Create or edit a role
3. Add rules to grant **read** access to the secrets your application needs
4. Associate the role with your API Key auth method

## Troubleshooting

### Secret not found
- Verify the secret exists in the Akeyless Console
- Check the full secret path (e.g., `/MyFolder/MySecret`)
- Ensure the path starts with `/`
- If using `pathPrefix`, check the combined path is correct

### JSON key not found
- Verify the key exists in the secret value
- Key names are case-sensitive
- For static secrets, ensure the value is valid JSON when using `#KEY` or `key=`

### Permission denied
- Check the Access Role associated with your API Key auth method
- Ensure the role includes read permission for the secret path
- Verify the role is associated with the correct auth method

### Authentication failed
- Verify the Access ID starts with `p-` (API Key auth)
- Ensure the Access Key matches the Access ID
- If using a Gateway, verify the `apiUrl` is correct and reachable
- Check if the auth method is active in the Akeyless Console
