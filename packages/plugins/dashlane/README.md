# @varlock/dashlane-plugin

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [Dashlane](https://www.dashlane.com/) into your configuration. It wraps the [Dashlane CLI (`dcli`)](https://github.com/Dashlane/dashlane-cli) to resolve secrets via `dl://` references.

> **Requires `dcli` installed and available in your `PATH`.** See [installation docs](https://cli.dashlane.com/installation).

## Features

- **Fast lookups by ID** - Uses `dcli read` which fetches individual secrets without decrypting the full vault
- **Title-based lookups** - Also supports `dl://<title>/field` for convenience (slower, requires vault decryption)
- **Pre-authenticated and headless auth** - Works with existing `dcli sync` sessions or service device keys for CI/CD
- **Multiple instances** for accessing different Dashlane accounts or devices
- **In-session caching** - Each secret is fetched only once per resolution
- **Helpful error messages** with resolution tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly:
```bash
npm install @varlock/dashlane-plugin
```
And then register the plugin without any version number:
```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin)
```

Otherwise just set the explicit version number when you register it:
```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin@0.0.0)
```

See the [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Prerequisites

You must have the Dashlane CLI (`dcli`) installed on your system. See the [installation docs](https://cli.dashlane.com/installation) for setup instructions.

After installing, authenticate and sync your vault:

```bash
# Interactive login (opens browser)
dcli sync

# Or register a device for headless/CI use
dcli devices register "my-server"
```

See the [Dashlane CLI documentation](https://cli.dashlane.com/) for full setup instructions.

The plugin does **not** fail at load time if `dcli` is not installed -- it only fails when you actually try to resolve a secret.

## Setup

After registering the plugin, initialize it with the `@initDashlane` root decorator.

### Basic setup

For interactive use (local development), no configuration is needed:

```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin)
# @initDashlane()
```

This relies on an existing `dcli sync` session for authentication. Remember to run `dcli lock` when you are done to lock your vault.

### Headless setup (CI/CD)

For headless environments, provide service device keys:

```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin)
# @initDashlane(serviceDeviceKeys=$DASHLANE_SERVICE_DEVICE_KEYS)
```

The `$DASHLANE_SERVICE_DEVICE_KEYS` reference is resolved from the environment at runtime (e.g., from `.env.local` or a CI environment variable). The value itself is a `dls_*` credential string output by device registration:

```bash
dcli devices register "my-ci-server"
# Outputs: dls_<base64-encoded-keys>
```

### Multiple instances

Access multiple Dashlane accounts or devices:

```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin)
# @initDashlane(id=prod, serviceDeviceKeys=$PROD_DL_KEYS)
# @initDashlane(id=dev, serviceDeviceKeys=$DEV_DL_KEYS)
# ---

PROD_SECRET=dashlane(prod, "dl://secret_id/password")
DEV_SECRET=dashlane(dev, "dl://secret_id/password")
```

## Loading secrets

Once initialized, use the `dashlane()` resolver function to fetch secrets via `dl://` references.

### By entry ID (recommended)

The fastest method. `dcli read` fetches a specific secret by its vault ID without decrypting the full vault:

```env-spec title=".env.schema"
# @plugin(@varlock/dashlane-plugin)
# @initDashlane()
# ---

DB_PASSWORD=dashlane("dl://00F9FB5E-A042-4351-AFF2-46DF39DEF77F/password")
DB_USER=dashlane("dl://00F9FB5E-A042-4351-AFF2-46DF39DEF77F/login")
API_KEY=dashlane("dl://A1B2C3D4-E5F6-7890-ABCD-EF1234567890/password")
```

### By title (slower)

`dcli read` also accepts titles in `dl://` references. This is slower since it requires full vault decryption, but more readable:

```env-spec title=".env.schema"
DB_PASSWORD=dashlane("dl://MyDatabase/password")
STRIPE_KEY=dashlane("dl://Stripe API/password")
```

Using IDs is recommended for reliability and performance.

### Finding entry identifiers

List your vault entries with their IDs:

```bash
# List all passwords with titles and IDs
dcli password -o json | jq '.[] | {title, id}'

# Example output:
# { "title": "MyDatabase", "id": "{00F9FB5E-A042-4351-AFF2-46DF39DEF77F}" }
# { "title": "Stripe API", "id": "{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}" }

# List secure notes
dcli note -o json | jq '.[] | {title, id}'

# List secrets
dcli secret -o json | jq '.[] | {title, id}'
```

When using the ID in a `dl://` reference, **strip the curly braces**:

```
# dcli shows: {00F9FB5E-A042-4351-AFF2-46DF39DEF77F}
# Use:        dl://00F9FB5E-A042-4351-AFF2-46DF39DEF77F/password
```

### Available fields

The field after the ID specifies which property to retrieve:

| Field | Description |
|-------|-------------|
| `password` | The entry's password |
| `login` | The entry's username/login |
| `email` | The entry's email address |
| `url` | The entry's associated URL |
| `note` | The entry's notes field |

---

## Reference

### Root decorators

#### `@initDashlane()`

Initialize a Dashlane plugin instance.

**Parameters:**
- `serviceDeviceKeys?: string` - Service device keys (`dls_*` credential) for headless authentication
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Resolver functions

#### `dashlane()`

Fetch a secret from Dashlane via a `dl://` reference.

**Signatures:**
- `dashlane(dlRef)` - Fetch by `dl://` reference
- `dashlane(instanceId, dlRef)` - Fetch from a specific instance

**Returns:** The resolved secret value as a string.

### Data types

#### `dashlaneDeviceKeys`

Validates the `dls_*` format for Dashlane service device keys. Marked as sensitive.

```env-spec title=".env.schema"
# @type(dashlaneDeviceKeys)
DASHLANE_SERVICE_DEVICE_KEYS=
```

---

## How it works

Under the hood, the plugin:

1. Executes `dcli read <dl://reference>` as a subprocess for each secret
2. Delegates authentication to `dcli` -- either via an existing interactive session or service device keys passed as the `DASHLANE_SERVICE_DEVICE_KEYS` environment variable
3. Caches resolved values in memory for the duration of a single resolution session (no secrets are persisted)

### Sync behavior

`dcli read` works against a **local vault cache** that auto-syncs with Dashlane's servers once per hour. This means:

- Secrets changed less than 1 hour ago may not be reflected without a manual sync
- Run `dcli sync` to force a fresh sync before resolving
- Auto-sync can be disabled entirely via `dcli configure disable-auto-sync true`

For most use cases the auto-sync is sufficient. If freshness is critical, run `dcli sync` before your Varlock resolution step.

## Troubleshooting

### `dcli` command not found

Install the Dashlane CLI following the [installation docs](https://cli.dashlane.com/installation) and ensure `dcli` is in your `PATH`.

### Authentication failed

- For interactive use, run `dcli sync` and authenticate via your browser
- For headless use, verify your `DASHLANE_SERVICE_DEVICE_KEYS` value is correct and the device hasn't been revoked
- Check device status: `dcli devices list`

### Entry not found

- Verify the entry exists: `dcli password -o json | jq '.[].title'`
- Ensure the ID in your `dl://` reference doesn't include curly braces
- If using a title, ensure it matches exactly (case-sensitive)

### Vault locked or not synced

- Run `dcli sync` to sync and unlock your vault
- If the vault is locked, you may need to enter your master password

### Stale secrets

If a recently changed secret isn't reflected:
- Run `dcli sync` to force a fresh sync
- The local cache auto-syncs every hour; changes within that window require a manual sync

## Resources

- [Dashlane CLI documentation](https://cli.dashlane.com/)
- [Dashlane CLI GitHub repository](https://github.com/Dashlane/dashlane-cli)
- [Dashlane CLI installation guide](https://cli.dashlane.com/installation)
- [Dashlane CLI device registration](https://cli.dashlane.com/personal/devices)
