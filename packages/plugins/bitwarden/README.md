# @varlock/bitwarden-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/bitwarden-plugin.svg)](https://www.npmjs.com/package/@varlock/bitwarden-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/bitwarden-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from Bitwarden into your configuration. It supports both [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) (via access tokens over the REST API, using `@initBitwarden` + `bitwarden()`) and the [Bitwarden Password Manager](https://bitwarden.com/products/personal/) / self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) (via the `bw` CLI, using `@initBwp` + `bwp()`).

See the [full documentation](https://varlock.dev/plugins/bitwarden/) for details.

## Features

- **Zero-config authentication** - Just provide your machine account access token
- **UUID-based secret access** - Fetch secrets by their unique identifiers
- **Organization support** - Optional organization ID for filtering and management
- **Self-hosted Bitwarden support** - Configure custom API and identity URLs
- **Multiple instances** - Connect to different organizations or self-hosted instances
- **Comprehensive error handling** with helpful tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/bitwarden-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin@1.2.3)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initBitwarden` root decorator.

### Basic Setup

For most use cases, you only need to provide the access token:

```env-spec
# @plugin(@varlock/bitwarden-plugin)
# @initBitwarden(accessToken=$BITWARDEN_ACCESS_TOKEN)
# ---

# @type=bitwardenAccessToken @sensitive
BITWARDEN_ACCESS_TOKEN=
```

**How to get an access token:**

1. Navigate to your Bitwarden organization's **Secrets Manager**
2. Go to **Machine accounts** → Create a new machine account
3. Copy the **Access token** (displayed only once!)
4. Grant the machine account access to the secrets or projects you need

### Self-hosted

For self-hosted Bitwarden instances, you'll need to provide both URLs:

```env-spec
# @initBitwarden(
#   accessToken=$BITWARDEN_ACCESS_TOKEN,
#   apiUrl="https://bitwarden.yourcompany.com/api",
#   identityUrl="https://bitwarden.yourcompany.com/identity"
# )
```

- `apiUrl` - API URL for your self-hosted instance (e.g., "https://bitwarden.yourcompany.com/api")
- `identityUrl` - Identity service URL for your self-hosted instance (e.g., "https://bitwarden.yourcompany.com/identity")

### Multiple instances

If you need to connect to multiple organizations or instances, register multiple named instances:

```env-spec
# @initBitwarden(id=prod, accessToken=$PROD_ACCESS_TOKEN)
# @initBitwarden(id=dev, accessToken=$DEV_ACCESS_TOKEN)
```

## Reading secrets

This plugin introduces the `bitwarden()` function to fetch secret values.

```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin)
# @initBitwarden(accessToken=$BITWARDEN_ACCESS_TOKEN)
# ---

# @type=bitwardenAccessToken @sensitive
BITWARDEN_ACCESS_TOKEN=

# Fetch secrets by UUID
DATABASE_URL=bitwarden("12345678-1234-1234-1234-123456789abc")
API_KEY=bitwarden("87654321-4321-4321-4321-cba987654321")

# If using multiple instances
PROD_SECRET=bitwarden(prod, "11111111-1111-1111-1111-111111111111")
DEV_SECRET=bitwarden(dev, "22222222-2222-2222-2222-222222222222")
```

### Finding Secret UUIDs

To find a secret's UUID:

1. Open your Bitwarden Secrets Manager
2. Navigate to the secret
3. Copy the UUID from the URL or secret details (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

---

## Password Manager / Vaultwarden

Separate from Secrets Manager, you can load values from your personal/team **Bitwarden Password Manager** vault — or a self-hosted **Vaultwarden** server — using the [`bw` CLI](https://bitwarden.com/help/cli/). varlock unlocks the vault for you (prompting for your master password on first use) and caches the resulting session token, so you never have to manually unlock and paste a token.

Install the `bw` CLI from a trusted source and log in once (`bw login`), then:

```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin)
# @initBwp()
# ---

# defaults to the item's password
DATABASE_PASSWORD=bwp("Production DB")
# other fields: username, notes, totp, uri, or a custom field name
# (totp returns the stored TOTP secret/seed, not a generated 6-digit code)
DATABASE_USER=bwp("Production DB", field=username)
```

The cached session token lives in varlock's encrypted cache (biometric-gated on platforms with a secure enclave) and by default is reused indefinitely (`sessionTtl="forever"`). The `bw` CLI session does not auto-lock on system sleep/lock/restart (those are app-only settings), so a fresh master-password unlock is only needed when the session is invalidated externally (`bw lock`/`bw logout`, an external `bw unlock`, or account policy); set a shorter `sessionTtl` to force periodic re-auth. For CI / non-interactive use, pass a pre-obtained token (`@initBwp(sessionToken=$BWP_SESSION)`) or a master password (`@initBwp(masterPassword=$BW_MASTER_PASSWORD)`). To read from multiple accounts/servers, give each instance its own bw data dir (`@initBwp(id=work, appDataDir="…")`). See the [full docs](https://varlock.dev/plugins/bitwarden/#password-manager--vaultwarden) for all options.

---

## Reference

### Root decorators

#### `@initBitwarden()`

Initialize a Bitwarden Secrets Manager plugin instance.

**Parameters:**

- `accessToken: string` (required) - Machine account access token
- `apiUrl?: string` - API URL for self-hosted Bitwarden (defaults to `https://api.bitwarden.com`)
- `identityUrl?: string` - Identity service URL for self-hosted Bitwarden (defaults to `https://identity.bitwarden.com`)
- `cacheTtl?: string | number` - Cache resolved values from `bitwarden()` for the provided TTL (`"5m"`, `"1h"`, `"1d"`, or `"forever"` to cache until manually cleared); set to `false` (or an empty string) to disable caching
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `bitwarden()`

Fetch a secret from Bitwarden Secrets Manager.

**Signatures:**

- `bitwarden(secretId)` - Fetch by secret UUID from default instance
- `bitwarden(instanceId, secretId)` - Fetch from a specific instance

**Secret ID Format:**

- Must be a valid UUID: `"12345678-1234-1234-1234-123456789abc"`

### Data Types

- `bitwardenAccessToken` - Machine account access token (sensitive)
- `bitwardenSecretId` - Secret UUID (validated format)
- `bitwardenOrganizationId` - Organization UUID (validated format)

---

## Bitwarden Setup

### Create a Machine Account

Machine accounts provide programmatic access to Bitwarden Secrets Manager.

**Using the Web Vault:**

1. Log in to your Bitwarden organization
2. Navigate to **Secrets Manager** → **Machine accounts**
3. Click **New machine account**
4. Provide a name (e.g., "Production App")
5. Copy the **Access token** (shown only once!)
6. Grant access to specific projects or secrets

**Permission Levels:**

- **Can read** - Retrieve secrets only
- **Can read, write** - Retrieve, create, and edit secrets

**Important:** Store the access token securely - it will only be displayed once!

### Grant Access to Secrets

**Via Projects:**

1. Create or select a project in Secrets Manager
2. Add secrets to the project
3. Grant your machine account access to the project

**Direct Secret Access:**

1. Navigate to a specific secret
2. Click **Access**
3. Add your machine account with appropriate permissions

### Find Your Organization ID

```bash
# Via Bitwarden CLI
bw org list

# Or check your organization's URL
https://vault.bitwarden.com/#/organizations/{organization-id}
```

## Troubleshooting

### Secret not found
- Verify the secret UUID is correct (must be valid UUID format)
- Check that the secret exists in your Bitwarden Secrets Manager
- Ensure your machine account has access to the secret or its project

### Permission denied
- Verify your machine account has "Can read" or "Can read, write" permissions
- Check that the machine account has access to the specific secret
- Review the access settings in Bitwarden Secrets Manager console

### Authentication failed
- Verify the access token is correct
- Check if the access token has been revoked or expired
- Ensure the machine account is not disabled
- For self-hosted: verify apiUrl and identityUrl are correct

### Invalid UUID format
- Secret IDs must be valid UUIDs: `12345678-1234-1234-1234-123456789abc`
- Check for typos or incorrect format
- UUIDs should contain 32 hexadecimal characters and 4 hyphens

## Resources

- [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/)
- [Machine Accounts Documentation](https://bitwarden.com/help/machine-accounts/)
- [Self-Hosting Bitwarden](https://bitwarden.com/help/manage-your-secrets-org/#self-hosting)
