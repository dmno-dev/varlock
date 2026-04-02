# @varlock/keeper-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/keeper-plugin.svg)](https://www.npmjs.com/package/@varlock/keeper-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/keeper-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [Keeper Security](https://keepersecurity.com/) vaults via the [Keeper Secrets Manager](https://docs.keeper.io/secrets-manager/) SDK.

## Features

- 🔐 Fetch individual secrets by record UID, title, or Keeper notation
- 🏷️ Access standard and custom fields (password, login, URL, notes, etc.)
- 🔑 Secure authentication via base64-encoded Secrets Manager configuration
- 📦 Multiple instance support for different vaults or applications
- ✅ Built-in validation for Keeper Secrets Manager config tokens

## Installation

```bash
# npm
npm install @varlock/keeper-plugin

# pnpm
pnpm add @varlock/keeper-plugin

# yarn
yarn add @varlock/keeper-plugin

# bun
bun add @varlock/keeper-plugin
```

## Prerequisites

You need a [Keeper Secrets Manager](https://docs.keeper.io/secrets-manager/) application set up in your Keeper vault:

1. In the Keeper Admin Console, create a **Secrets Manager Application**
2. Share a folder with the application
3. Generate a **one-time access token**
4. Use the [KSM CLI](https://docs.keeper.io/secrets-manager/secrets-manager/secrets-manager-command-line-interface) to initialize a config:

```bash
pip install keeper-secrets-manager-cli
ksm profile init <one-time-token>
ksm profile export --format json | base64
```

5. Store the base64-encoded config as the `KSM_CONFIG` environment variable

## Setup

### Basic setup

```env-spec title=".env.schema"
# @plugin(@varlock/keeper-plugin)
# @initKeeper(token=$KSM_CONFIG)
# ---

# @type=keeperSmToken @sensitive
KSM_CONFIG=
```

### Multiple instances

```env-spec title=".env.schema"
# @plugin(@varlock/keeper-plugin)
# @initKeeper(token=$KSM_CONFIG_PROD, id=prod)
# @initKeeper(token=$KSM_CONFIG_DEV, id=dev)
# ---

# @type=keeperSmToken @sensitive
KSM_CONFIG_PROD=

# @type=keeperSmToken @sensitive
KSM_CONFIG_DEV=
```

## Loading secrets

### By record UID (defaults to password field)

```env-spec title=".env.schema"
# fetches the "password" field from the record
DB_PASSWORD=keeper("XXXXXXXXXXXXXXXXXXXX")
```

### By record UID with a specific field

```env-spec title=".env.schema"
# fetch the "login" standard field
DB_USER=keeper("XXXXXXXXXXXXXXXXXXXX#login")

# fetch a custom field by label
API_KEY=keeper("XXXXXXXXXXXXXXXXXXXX#API_KEY")

# or use the named field parameter
DB_HOST=keeper("XXXXXXXXXXXXXXXXXXXX", field="host")
```

### Using Keeper notation

The plugin supports [Keeper's notation syntax](https://docs.keeper.io/secrets-manager/secrets-manager/developer-sdk-library/javascript-sdk#notation) for more advanced access patterns:

```env-spec title=".env.schema"
# standard field by type
DB_PASS=keeper("XXXX/field/password")

# standard field by label
DB_LOGIN=keeper("XXXX/field/login")

# custom field by label
MY_SECRET=keeper("XXXX/custom_field/MySecretLabel")

# by record title instead of UID
API_KEY=keeper("My API Keys/field/password")
```

### With named instances

```env-spec title=".env.schema"
# first arg is instance id, second is the secret reference
PROD_SECRET=keeper(prod, "XXXX/field/password")
DEV_SECRET=keeper(dev, "YYYY#password")
```

## Reference

### Root decorators

#### `@initKeeper()`

Initialize a Keeper Secrets Manager plugin instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | yes | Base64-encoded Secrets Manager config (typically from `$KSM_CONFIG`) |
| `id` | string | no | Instance identifier for multiple configurations (defaults to `_default`) |

### Data types

#### `keeperSmToken`

A sensitive string type for Keeper Secrets Manager configuration tokens. Validates that the value is a valid base64-encoded JSON string.

### Resolver functions

#### `keeper(reference)` / `keeper(instanceId, reference)`

Fetch a single secret field from Keeper.

**Arguments:**

| Position | Type | Required | Description |
|----------|------|----------|-------------|
| 1 | string | yes (if no instanceId) | Secret reference (see formats below) |
| 1, 2 | string, string | for named instances | Instance ID, then secret reference |

**Named parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `field` | string | no | Explicit field type/label to extract |

**Reference formats:**

| Format | Description | Example |
|--------|-------------|---------|
| `<uid>` | Record UID (defaults to password field) | `keeper("XXXX")` |
| `<uid>#<field>` | Record UID with field selector | `keeper("XXXX#login")` |
| `<uid>/field/<type>` | Keeper notation (standard field) | `keeper("XXXX/field/password")` |
| `<uid>/custom_field/<label>` | Keeper notation (custom field) | `keeper("XXXX/custom_field/API_KEY")` |
| `<title>/field/<type>` | Keeper notation (by title) | `keeper("My Record/field/password")` |

## Keeper Secrets Manager setup guide

### Step 1: Create a Secrets Manager Application

1. Log in to the [Keeper Admin Console](https://keepersecurity.com/console)
2. Navigate to **Secrets Manager** → **Applications**
3. Click **Create Application**
4. Give it a descriptive name (e.g., "varlock-dev")

### Step 2: Share folders

1. In your Keeper vault, right-click the folder containing your secrets
2. Select **Share Folder**
3. Share it with your Secrets Manager application

### Step 3: Generate a one-time access token

1. In the application settings, click **Add Device**
2. Copy the one-time access token

### Step 4: Initialize and export the config

```bash
# Install the KSM CLI
pip install keeper-secrets-manager-cli

# Initialize with the one-time token
ksm profile init <one-time-token>

# Export as base64 for use as an env var
ksm profile export --format json | base64
```

### Step 5: Set up your schema

```env-spec title=".env.schema"
# @plugin(@varlock/keeper-plugin)
# @initKeeper(token=$KSM_CONFIG)
# ---

# @type=keeperSmToken @sensitive
KSM_CONFIG=

# Your secrets
DB_PASSWORD=keeper("your-record-uid/field/password")
API_KEY=keeper("your-record-uid/custom_field/api_key")
```

## Troubleshooting

### "Failed to parse Keeper config token"

The `KSM_CONFIG` value must be a valid base64-encoded JSON string. Regenerate it:
```bash
ksm profile export --format json | base64
```

### "Keeper access denied"

- Verify the Secrets Manager application has not been revoked
- Check that the shared folder permissions are still active
- The one-time token may have expired before being used — generate a new one

### "Record not found"

- Verify the record UID or title is correct
- Ensure the record is in a folder shared with the Secrets Manager application
- Record UIDs are case-sensitive

### "Field not found in record"

- Check available field types with `keeper("uid/field/password")`
- Custom fields use the label: `keeper("uid/custom_field/My Label")`
- Standard field types include: `login`, `password`, `url`, `oneTimeCode`, `note`

## Links

- [Varlock Documentation](https://varlock.dev)
- [Keeper Security](https://keepersecurity.com/)
- [Keeper Secrets Manager Docs](https://docs.keeper.io/secrets-manager/)
- [JavaScript SDK Docs](https://docs.keeper.io/secrets-manager/secrets-manager/developer-sdk-library/javascript-sdk)
- [KSM CLI Docs](https://docs.keeper.io/secrets-manager/secrets-manager/secrets-manager-command-line-interface)
