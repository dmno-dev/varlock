# @varlock/bitwarden-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/bitwarden-plugin.svg)](https://www.npmjs.com/package/@varlock/bitwarden-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/bitwarden-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from **Bitwarden** into your configuration.

It supports two distinct Bitwarden products:

| Feature | Bitwarden Secrets Manager | Bitwarden Password Manager / Vaultwarden |
|---------|--------------------------|------------------------------------------|
| Auth    | Machine account access token (`BWS_ACCESS_TOKEN`) | CLI session token (`bw unlock`) |
| Access  | REST API (no CLI needed) | `bw` CLI required |
| Ideal for | Production / CI environments | Local development |
| Vaultwarden support | ✗ (Vaultwarden does not offer Secrets Manager) | ✓ |

## Features

**Secrets Manager (existing)**
- **Zero-config authentication** - Just provide your machine account access token
- **UUID-based secret access** - Fetch secrets by their unique identifiers
- **Self-hosted Bitwarden support** - Configure custom API and identity URLs
- **Multiple instances** - Connect to different organizations or self-hosted instances

**Password Manager / Vaultwarden (new)**
- **CLI-based access** via the official `bw` CLI tool
- **Fetch any field** - password, username, notes, TOTP, URI, or custom fields
- **Vaultwarden support** - Works with any Bitwarden-compatible server
- **Multiple instances** - Connect to different vaults

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

---

## Bitwarden Secrets Manager

The Secrets Manager integration uses a machine account access token and communicates directly with the Bitwarden API — no CLI required.

### Setup + Auth

After registering the plugin, you must initialize it with the `@initBitwarden` root decorator.

#### Basic Setup

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

#### Self-hosted

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

#### Multiple instances

If you need to connect to multiple organizations or instances, register multiple named instances:

```env-spec
# @initBitwarden(id=prod, accessToken=$PROD_ACCESS_TOKEN)
# @initBitwarden(id=dev, accessToken=$DEV_ACCESS_TOKEN)
```

### Reading secrets

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

## Bitwarden Password Manager / Vaultwarden

The Password Manager integration uses the official `bw` CLI tool.  This makes it easy to use with **Vaultwarden** (the open-source self-hosted alternative) and regular Bitwarden password vault accounts, which do not have machine accounts.

> **Note:** Because this relies on the `bw` CLI and an interactive session token it is primarily intended for **local development**. For production/CI use, prefer Bitwarden Secrets Manager (above) or another provider that supports non-interactive machine authentication.

### Prerequisites

Install the [Bitwarden CLI](https://bitwarden.com/help/cli/):

```bash
# macOS
brew install bitwarden-cli

# Linux (snap)
snap install bw

# Windows
choco install bitwarden-cli
```

#### Vaultwarden / self-hosted server

Point the CLI at your self-hosted server before logging in:

```bash
bw config server https://vaultwarden.yourcompany.com
```

### Setup + Auth

1. **Log in** (one-time setup):

   ```bash
   bw login
   ```

2. **Unlock** your vault and capture the session token:

   ```bash
   export BWP_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
   ```

   Or unlock interactively and copy the token:

   ```bash
   bw unlock
   # copy the export line it prints, e.g.:
   # export BW_SESSION="<token>"
   ```

3. **Configure** the plugin:

```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin)
# @initBwp(sessionToken=$BWP_SESSION)
# ---

# @type=bwSessionToken @sensitive
BWP_SESSION=
```

### Reading items

Use the `bwp()` function to fetch values from your vault:

```env-spec title=".env.schema"
# @plugin(@varlock/bitwarden-plugin)
# @initBwp(sessionToken=$BWP_SESSION)
# ---

# @type=bwSessionToken @sensitive
BWP_SESSION=

# Fetch the password field (default)
DATABASE_URL=bwp("My Database Item")

# Fetch specific fields
DB_USER=bwp("My Database Item", field="username")
DB_NOTES=bwp("My Database Item", field="notes")
DB_TOTP=bwp("My Database Item", field="totp")
DB_URI=bwp("My Database Item", field="uri")

# Fetch a custom field
API_KEY=bwp("API Keys", field="production_api_key")
```

You can also use the item's UUID instead of its name:

```env-spec
DATABASE_URL=bwp("12345678-1234-1234-1234-123456789abc")
```

### Multiple instances

```env-spec
# @initBwp(id=work, sessionToken=$BWP_WORK_SESSION)
# @initBwp(id=personal, sessionToken=$BWP_PERSONAL_SESSION)

WORK_SECRET=bwp(work, "Work Item")
PERSONAL_SECRET=bwp(personal, "Personal Item")
```

---

## Reference

### Root decorators

#### `@initBitwarden()`

Initialize a Bitwarden **Secrets Manager** plugin instance.

**Parameters:**

- `accessToken: string` (required) - Machine account access token
- `apiUrl?: string` - API URL for self-hosted Bitwarden (defaults to `https://api.bitwarden.com`)
- `identityUrl?: string` - Identity service URL for self-hosted Bitwarden (defaults to `https://identity.bitwarden.com`)
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

#### `@initBwp()`

Initialize a Bitwarden **Password Manager / Vaultwarden** plugin instance (uses the `bw` CLI).

**Parameters:**

- `sessionToken: string` (required) - CLI session token from `bw unlock`
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `bitwarden()`

Fetch a secret from Bitwarden **Secrets Manager**.

**Signatures:**

- `bitwarden(secretId)` - Fetch by secret UUID from default instance
- `bitwarden(instanceId, secretId)` - Fetch from a specific instance

**Secret ID Format:**

- Must be a valid UUID: `"12345678-1234-1234-1234-123456789abc"`

#### `bwp()`

Fetch a field value from a Bitwarden **Password Manager / Vaultwarden** vault item via the `bw` CLI.

**Signatures:**

- `bwp("item")` - Fetch the `password` field of the named item (default instance)
- `bwp("item", field="username")` - Fetch a specific field (default instance)
- `bwp(instanceId, "item")` - Use a named instance
- `bwp(instanceId, "item", field="notes")` - Named instance + specific field

**Supported fields:**

- `password` (default) - Login password
- `username` - Login username
- `notes` - Secure notes
- `totp` - TOTP secret / code
- `uri` - First URI in the login entry
- Any custom field name - Matches case-insensitively against the item's custom fields

### Data Types

- `bitwardenAccessToken` - Secrets Manager machine account access token (sensitive)
- `bitwardenSecretId` - Secret UUID (validated format)
- `bitwardenOrganizationId` - Organization UUID (validated format)
- `bwSessionToken` - Bitwarden CLI session token from `bw unlock` (sensitive)

---

## Troubleshooting

### Secret not found (Secrets Manager)
- Verify the secret UUID is correct (must be valid UUID format)
- Check that the secret exists in your Bitwarden Secrets Manager
- Ensure your machine account has access to the secret or its project

### Permission denied (Secrets Manager)
- Verify your machine account has "Can read" or "Can read, write" permissions
- Check that the machine account has access to the specific secret
- Review the access settings in Bitwarden Secrets Manager console

### Authentication failed (Secrets Manager)
- Verify the access token is correct
- Check if the access token has been revoked or expired
- Ensure the machine account is not disabled
- For self-hosted: verify apiUrl and identityUrl are correct

### Invalid UUID format (Secrets Manager)
- Secret IDs must be valid UUIDs: `12345678-1234-1234-1234-123456789abc`
- Check for typos or incorrect format
- UUIDs should contain 32 hexadecimal characters and 4 hyphens

### `bw` CLI not found (Password Manager)
- Install the Bitwarden CLI: https://bitwarden.com/help/cli/
- Ensure `bw` is available in your `$PATH`

### Session invalid or expired (Password Manager)
- Run `bw unlock` again to get a fresh session token
- Update your `BWP_SESSION` (or whichever env var you use) with the new token

### Item not found (Password Manager)
- Verify the item name matches exactly (or use its UUID)
- Run `bw list items` to see all items in your vault
- Make sure your vault is synced: `bw sync`

## Resources

- [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/)
- [Machine Accounts Documentation](https://bitwarden.com/help/machine-accounts/)
- [Bitwarden CLI](https://bitwarden.com/help/cli/)
- [Vaultwarden (self-hosted)](https://github.com/dani-garcia/vaultwarden)
- [Self-Hosting Bitwarden](https://bitwarden.com/help/manage-your-secrets-org/#self-hosting)
