# @varlock/hashicorp-vault-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/hashicorp-vault-plugin.svg)](https://www.npmjs.com/package/@varlock/hashicorp-vault-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/hashicorp-vault-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [HashiCorp Vault](https://www.vaultproject.io/) (KV v2 secrets engine) / [OpenBao](https://openbao.org/) into your configuration.

## Features

- **Zero-config authentication** - Automatically uses Vault token from environment or CLI
- **AppRole authentication** - For automated and CI/CD workflows
- **Vault CLI integration** - Works seamlessly with `vault login` for local development
- **Auto-infer secret keys** from environment variable names
- **JSON key extraction** from secrets using `#` syntax or named `key` parameter
- **Path prefixing** with `pathPrefix` option for organized secret management
- **Default path** support for sharing a common secret path across items
- Support for Vault Enterprise namespaces
- Support for multiple Vault instances
- Automatic AppRole token caching and renewal
- Lightweight implementation using REST API (no heavy Vault SDK dependencies)

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/hashicorp-vault-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/hashicorp-vault-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/hashicorp-vault-plugin@1.2.3)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initHcpVault` root decorator.

### Automatic auth

For most use cases, you only need to provide the Vault URL:

```env-spec
# @plugin(@varlock/hashicorp-vault-plugin)
# @initHcpVault(url="https://vault.example.com:8200")
```

**How this works:**

- **Local development:** Run `vault login` → automatically uses the token from `~/.vault-token`
- **CI/CD pipelines:** Wire up a token explicitly via `token=$VAULT_TOKEN`
- **Works everywhere** with zero configuration beyond the URL!

### AppRole auth (For automated workflows)

For CI/CD or server environments, use AppRole authentication:

```env-spec
# @plugin(@varlock/hashicorp-vault-plugin)
# @initHcpVault(
#   url="https://vault.example.com:8200",
#   roleId=$VAULT_ROLE_ID,
#   secretId=$VAULT_SECRET_ID
# )
# ---

VAULT_ROLE_ID=
# @sensitive
VAULT_SECRET_ID=
```

You would then need to inject these env vars using your CI/CD system.

### Explicit token

You can also provide a token directly:

```env-spec
# @initHcpVault(
#   url="https://vault.example.com:8200",
#   token=$VAULT_TOKEN
# )
# ---

# @type=vaultToken @sensitive
VAULT_TOKEN=
```

### Authentication Priority

The plugin tries authentication methods in this order:
1. **Explicit token** - If `token` is provided in `@initHcpVault()`
2. **AppRole** - If both `roleId` and `secretId` are provided
3. **CLI token file** - From `~/.vault-token` (created by `vault login`) or `~/.bao-token` (created by `bao login` for OpenBao)

### Vault Enterprise namespaces

For Vault Enterprise, specify the namespace:

```env-spec
# @initHcpVault(url="https://vault.example.com:8200", namespace="admin/team-a")
```

### Multiple instances

If you need to connect to multiple Vault instances, register named instances:

```env-spec
# @initHcpVault(id=prod, url="https://vault-prod.example.com:8200")
# @initHcpVault(id=dev, url="https://vault-dev.example.com:8200")
```

## Reading secrets

This plugin introduces the `vaultSecret()` function to fetch secret values from Vault's KV v2 secrets engine.

```env-spec title=".env.schema"
# @plugin(@varlock/hashicorp-vault-plugin)
# @initHcpVault(url="https://vault.example.com:8200")
# ---

# Auto-infer: uses item key as the secret ref
DATABASE_URL=vaultSecret()

# Explicit path with key extraction via #
DB_HOST=vaultSecret("secret/db/config#HOST")
DB_PASSWORD=vaultSecret("secret/db/config#PASSWORD")

# Or use named "key" parameter
DB_PORT=vaultSecret("secret/db/config", key="PORT")

# If using multiple instances
PROD_KEY=vaultSecret(prod, "secret/api/keys#API_KEY")
DEV_KEY=vaultSecret(dev, "secret/api/keys#API_KEY")
```

### Default path

Use `defaultPath` to set a common path for secrets when no path argument is provided:

```env-spec
# @initHcpVault(url="https://vault.example.com:8200", defaultPath=secret/myapp/config)
# ---

# Both fetch from "secret/myapp/config" using the item key
DB_PASSWORD=vaultSecret()
API_KEY=vaultSecret()

# Override the inferred key using # syntax
STRIPE_KEY=vaultSecret("#stripe_api_key")

# This still uses an explicit path
OTHER_SECRET=vaultSecret("secret/other/path#KEY")
```

### Path prefixing

Use `pathPrefix` to automatically prefix all secret paths:

```env-spec
# @initHcpVault(url="https://vault.example.com:8200", pathPrefix="secret/myapp")
# ---

# Fetches from "secret/myapp/db/config"
DB_HOST=vaultSecret("db/config#HOST")
```

You can even use dynamic prefixes:

```env-spec
# @initHcpVault(url="https://vault.example.com:8200", pathPrefix="secret/${ENV}")
# In prod: fetches from "secret/prod/..."
# In dev: fetches from "secret/dev/..."
DB_HOST=vaultSecret("db/config#HOST")
```

---

## Reference

### Root decorators

#### `@initHcpVault()`

Initialize a HashiCorp Vault plugin instance.

**Parameters:**

- `url: string` (required) - Vault server URL (e.g., `https://vault.example.com:8200`)
- `token?: string` - Explicit Vault authentication token
- `roleId?: string` - AppRole role ID for automated authentication
- `secretId?: string` - AppRole secret ID for automated authentication
- `namespace?: string` - Vault Enterprise namespace
- `defaultPath?: string` - Default secret path when no path argument is given to `vaultSecret()`
- `pathPrefix?: string` - Prefix automatically prepended to all secret paths
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `vaultSecret()`

Fetch a secret from HashiCorp Vault's KV v2 secrets engine.

**Signatures:**

- `vaultSecret()` - Auto-infers secret ref from variable name
- `vaultSecret(secretRef)` - Fetch by explicit path (with optional `#key`)
- `vaultSecret(secretRef, key="jsonKey")` - Fetch and extract a specific key
- `vaultSecret(instanceId, secretRef)` - Fetch from a specific Vault instance

**Secret Ref Formats:**

- Path only: `"secret/myapp/config"` (returns single value or JSON of all keys)
- Path with key: `"secret/myapp/config#DB_PASSWORD"` (extracts specific key)

**How paths work:**

Vault KV v2 stores key/value pairs at a path. Given a path like `secret/myapp/config`, the plugin calls `GET /v1/secret/data/myapp/config` (the first path segment is the mount point, and `/data/` is inserted for the KV v2 API).

### Data Types

- `vaultToken` - HashiCorp Vault authentication token (sensitive)

---

## Vault Setup

### Enable KV v2 Secrets Engine

```bash
# KV v2 is enabled by default at "secret/" in dev mode
# For production, enable it explicitly:
vault secrets enable -version=2 -path=secret kv
```

### Create a Policy

```hcl
# policy.hcl - Allow reading secrets
path "secret/data/*" {
  capabilities = ["read"]
}
```

```bash
vault policy write varlock-reader policy.hcl
```

### Set Up AppRole Auth (Recommended for CI/CD)

AppRole is the recommended auth method for automated workflows:

```bash
# Enable AppRole auth method
vault auth enable approle

# Create a role
vault write auth/approle/role/varlock-role \
  secret_id_ttl=24h \
  token_ttl=1h \
  token_max_ttl=4h \
  token_policies=varlock-reader

# Get the role ID
vault read auth/approle/role/varlock-role/role-id

# Generate a secret ID
vault write -f auth/approle/role/varlock-role/secret-id
```

Save the `role_id` and `secret_id` from the output for your CI/CD configuration.

### Create a Token (For simple setups)

```bash
# Create a token with the reader policy
vault token create -policy=varlock-reader -ttl=24h
```

### Store Secrets

```bash
# Store a single key/value
vault kv put secret/myapp/config DB_PASSWORD=supersecret

# Store multiple keys
vault kv put secret/myapp/config \
  DB_HOST=db.example.com \
  DB_PASSWORD=supersecret \
  API_KEY=abc123
```

## Troubleshooting

### Secret not found
- Verify the secret exists: `vault kv get secret/myapp/config`
- Check the mount point is correct (first path segment, typically `secret`)
- Ensure you're using KV v2, not KV v1 (different API format)

### Permission denied
- Check your token's policies: `vault token lookup`
- Ensure your policy includes `read` capability on `secret/data/*` (note the `/data/` prefix for KV v2)
- For AppRole: verify the role has the correct policies attached

### Authentication failed
- **Local dev:** Run `vault login` (or `bao login` for OpenBao) and ensure `VAULT_ADDR` is set correctly
- **CI/CD:** Verify your token or AppRole credentials are properly wired up in `@initHcpVault()`
- Check if the token has expired: `vault token lookup`
- For AppRole: verify the secret ID hasn't expired and generate a new one if needed
