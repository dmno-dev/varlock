# @varlock/passbolt-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/passbolt-plugin.svg)](https://www.npmjs.com/package/@varlock/passbolt-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/passbolt-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [Passbolt Secrets Manager](https://www.passbolt.com/) into your configuration.

## Features

- **Zero-config authentication** - Just provide your accountKit and passphrase
- **UUID-based secret access** - Fetch secrets by their unique identifiers
- **Bulk-load environments** with `passboltBulk()` or `passboltCustomFieldsObj()` via `@setValuesBulk`
- **Field extraction** from resources using `#` syntax or named `field` parameter (including custom fields)
- **Self-hosted Passbolt support** - API URL is read from your account kit
- **Multiple instances** - Connect to different organizations or self-hosted instances
- **Comprehensive error handling** with helpful tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/passbolt-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/passbolt-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/passbolt-plugin@1.2.3)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initPassbolt` root decorator.

### Basic Setup

You will need to provide your Passbolt account kit and its passphrase:

```env-spec
# @plugin(@varlock/passbolt-plugin)
# @initPassbolt(accountKit=$PB_ACCOUNT_KIT, passphrase=$PB_PASSPHRASE)
# ---
# @type=passboltAccountKit @sensitive
PB_ACCOUNT_KIT=
# @type=string @sensitive
PB_PASSPHRASE=
```

### Multiple instances

If you need to connect to multiple users or instances, register multiple named instances:

```env-spec
# @initPassbolt(id=prod, accountKit=$PROD_ACCOUNT_KIT, passphrase=$PROD_PASSPHRASE)
# @initPassbolt(id=dev, accountKit=$DEV_ACCOUNT_KIT, passphrase=$DEV_PASSPHRASE)
```

## Reading secrets

This plugin introduces the `passbolt()` function to fetch secret values.

```env-spec title=".env.schema"
# @plugin(@varlock/passbolt-plugin)
# @initPassbolt(accountKit=$PB_ACCOUNT_KIT, passphrase=$PB_PASSPHRASE)
# ---
# @type=passboltAccountKit @sensitive
PB_ACCOUNT_KIT=
# @type=string @sensitive
PB_PASSPHRASE=

# Fetch password (default field) by resource UUID
DATABASE_URL=passbolt("01234567-0123-4567-890a-bcdef0123456")
API_KEY=passbolt("76543210-3210-4321-a098-ba9876543210")

# Fetch a specific field using # syntax
LOGIN_URI=passbolt("01234567-0123-4567-890a-bcdef0123456#uri")
LOGIN_USERNAME=passbolt("01234567-0123-4567-890a-bcdef0123456#username")

# TOTP support
TOTP_SECRET=passbolt("01234567-0123-4567-890a-bcdef0123456#totp.secret")
TOTP_CODE=passbolt("01234567-0123-4567-890a-bcdef0123456#totp.code")

# Or use the named "field" parameter instead of # syntax
LOGIN_PASSWORD=passbolt("01234567-0123-4567-890a-bcdef0123456", field="password")

# Access custom fields by name (any unrecognized field name is treated as a custom field)
MY_CUSTOM=passbolt("01234567-0123-4567-890a-bcdef0123456#MyCustomField")
OTHER_FIELD=passbolt("01234567-0123-4567-890a-bcdef0123456", field="AnotherField")

# If using multiple instances
PROD_SECRET=passbolt(prod, "11111111-1111-4111-a111-111111111111")
DEV_SECRET=passbolt(dev, "22222222-2222-4222-b222-222222222222")
```

## Bulk Loading Secrets

Use `passboltBulk()` with `@setValuesBulk` to load all secrets (passwords) from a folder at once:

```env-spec title=".env.schema"
# @plugin(@varlock/passbolt-plugin)
# @initPassbolt(accountKit=$PB_ACCOUNT_KIT, passphrase=$PB_PASSPHRASE)
# @setValuesBulk(passboltBulk(folderPath="Database/Dev"))
# ---
# @type=passboltAccountKit @sensitive
PB_ACCOUNT_KIT=
# @type=string @sensitive
PB_PASSPHRASE=

# These will be populated from Passbolt (matched by resource name)
API_KEY=
DB_PASSWORD=
```

Or use `passboltCustomFieldsObj()` with `@setValuesBulk` to load all custom fields of a resource at once:

```env-spec title=".env.schema"
# @plugin(@varlock/passbolt-plugin)
# @initPassbolt(accountKit=$PB_ACCOUNT_KIT, passphrase=$PB_PASSPHRASE)
# @setValuesBulk(passboltCustomFieldsObj("01234567-0123-4567-890a-bcdef0123456"))
# ---
# @type=passboltAccountKit @sensitive
PB_ACCOUNT_KIT=
# @type=string @sensitive
PB_PASSPHRASE=

# These will be populated from Passbolt (matched by custom field name)
API_KEY=
DB_PASSWORD=
```

### Finding Resource UUIDs

To find a resource's UUID:

1. Open your Passbolt Secrets Manager
2. Navigate to the resource
3. Copy the UUID from the URL (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### Finding your account kit

To find your account kit:

1. Open your Passbolt Secrets Manager
2. Navigate to Manage account
3. Navigate to Desktop app setup
4. Click on Download your account kit and copy the contents

---

## Reference

### Root decorators

#### `@initPassbolt()`

Initialize a Passbolt Secrets Manager plugin instance.

**Parameters:**

- `accountKit: string` (required) - Passbolt account kit
- `passphrase: string` (required) - Passphrase to decrypt your private key
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `passbolt()`

Fetch a secret from a Passbolt resource.

**Signatures:**

- `passbolt(resourceId)` - Fetch password (default) by resource UUID from default instance
- `passbolt(resourceId, field="username")` - Fetch a specific field
- `passbolt(instanceId, resourceId)` - Fetch from a specific instance

**Resource ID Format:**

- Must be a valid UUID v4: `"12345678-1234-4567-abcd-123456789abc"`
- With a field: `"12345678-1234-4567-abcd-123456789abc#username"` (shorthand for field extraction)

**Built-in fields:**

- `"password"`: Extracts password from the resource (default when no field is given) 
- `"username"`: Extracts username from the resource
- `"uri"`: Extracts URI from the resource
- `"totp.secret"`: Extracts the TOTP secret from the resource
- `"totp.code"`: Generates the current TOTP code from the resource

Any other field name is treated as a **custom field** name and looked up in the resource's custom fields.

---

#### `passboltBulk()`

Bulk-load all passwords from a Passbolt folder. Returns a JSON object keyed by resource name. Designed for use with `@setValuesBulk`.

**Signatures:**

- `passboltBulk(folderPath="path")` - Load from default instance
- `passboltBulk(instanceId, folderPath="path")` - Load from a specific instance

**Folder path format:**

- Must be an existing folder e.g.: `"production"`
- Subfolders accessed with `/` delimiter e.g.: `"production/database"`
- Escape `/` in folder names with `\` e.g.: `"CI\/CD/DEV"`

---

#### `passboltCustomFieldsObj()`

Fetch all custom fields from a Passbolt resource as a JSON object. Designed for use with `@setValuesBulk`.

**Signatures:**

- `passboltCustomFieldsObj(resourceId)` - Fetch from default instance
- `passboltCustomFieldsObj(instanceId, resourceId)` - Fetch from a specific instance

**Resource ID Format:**

- See `passbolt()` function

---

### Data Types

- `passboltAccountKit` - Passbolt account kit (sensitive)

---

## Troubleshooting

### Resource not found
- Verify the resource UUID is correct (must be valid UUID v4 format)
- Check that the resource exists in your Passbolt Secrets Manager
- Ensure the resource is shared with your user

### Permission denied
- Verify the resource is shared with your user

### Authentication failed
- Verify the account kit is correct
- Ensure the passphrase is correct
