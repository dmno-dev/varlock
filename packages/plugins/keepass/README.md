# @varlock/keepass-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/keepass-plugin.svg)](https://www.npmjs.com/package/@varlock/keepass-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/keepass-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [KeePass](https://keepass.info/) / [KeePassXC](https://keepassxc.org/) databases (KDBX 4.0) into your configuration.

## Features

- **KDBX 4.0 support** — reads KeePass database files directly via [kdbxweb](https://github.com/keeweb/kdbxweb) with pure WASM argon2
- **KeePassXC CLI integration** — use `keepassxc-cli` for development workflows
- **Key file support** — authenticate with password + optional key file
- **Custom attributes** — read any entry field via `#attribute` syntax
- **Bulk loading** with `kpBulk()` via `@setValuesBulk` to load all entries in a group
- **Custom attributes object** — load all custom fields from a single entry via `customAttributesObj=true`
- **Multiple instances** for accessing different databases

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly:
```bash
npm install @varlock/keepass-plugin
```
And then register the plugin without any version number:
```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# ---
```

Otherwise just set the explicit version number when you register it:
```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin@0.0.1)
# ---
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Modes of operation

### File mode (default)

In file mode, the plugin opens and reads `.kdbx` files directly using [kdbxweb](https://github.com/keeweb/kdbxweb). No external CLI is needed.

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# ---
```

### CLI mode

When `useCli=true`, the plugin uses `keepassxc-cli` to read entries. This is useful during development when you want to leverage KeePassXC's system integration (e.g., YubiKey, Windows Hello). The `useCli` option can be dynamic — for example, `useCli=forEnv(dev)` to only use the CLI in development.

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD, useCli=true)
# ---
```

#### Prerequisites for CLI mode

You must have KeePassXC installed, which includes `keepassxc-cli`:

```bash
# macOS
brew install --cask keepassxc

# Ubuntu/Debian
sudo apt install keepassxc

# Fedora/RHEL
sudo dnf install keepassxc

# Arch
pacman -S keepassxc
```

See [KeePassXC downloads](https://keepassxc.org/download/) for more options.

## Setup

After registering the plugin, initialize it with the `@initKeePass` root decorator.

### Basic setup

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# ---

# @type=kdbxPassword @sensitive
KP_PASSWORD=
```

### With key file

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD, keyFile="./secrets.keyx")
# ---
```

### Multiple databases

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(id=prod, dbPath="./prod.kdbx", password=$KP_PROD_PASSWORD)
# @initKeePass(id=dev, dbPath="./dev.kdbx", password=$KP_DEV_PASSWORD)
# ---

PROD_DB_PASS=kp(prod, "Database/production")
DEV_DB_PASS=kp(dev, "Database/development")
```

## Loading secrets

Once initialized, use the `kp()` resolver to fetch secrets.

### Basic usage

```env-spec title=".env.schema"
# Fetch password (default attribute) from an entry
DB_PASSWORD=kp("Database/production")

# Fetch a different attribute using #attribute syntax
DB_USER=kp("Database/production#UserName")
DB_URL=kp("Database/production#URL")

# Read a custom string field
API_KEY=kp("Services/stripe#SecretKey")
```

### Inferring entry name from key

When the env var key matches a KeePass entry title, you can omit the entry path:

```env-spec title=".env.schema"
# Looks up entry titled "DB_PASSWORD", reads the Password field
DB_PASSWORD=kp()

# Looks up entry titled "DB_USER", reads the UserName field
DB_USER=kp("#UserName")
```

### Named attribute param

You can also use the `attribute` named param as an alternative to `#attribute`:

```env-spec title=".env.schema"
DB_USER=kp("Database/production", attribute=UserName)
```

### Entry paths

Entry paths use forward slashes to separate groups from the entry title:

```
Group/SubGroup/EntryTitle
```

For example, if your KeePass database has:
- Root
  - Database
    - production (entry with Password, UserName fields)
  - Services
    - stripe (entry with a custom "SecretKey" field)

You would reference them as `"Database/production"` and `"Services/stripe"`.

### Custom attributes object

Use `customAttributesObj=true` to load all custom (non-standard) fields from a single entry as a JSON object. This is useful with `@setValuesBulk` to expand custom fields into env vars:

```env-spec title=".env.schema"
# Given an entry "Database/production" with custom fields: HOST, PORT, DB_NAME
# @setValuesBulk(kp("Database/production", customAttributesObj=true), createMissing=true)
# ---
HOST=
PORT=
DB_NAME=
```

Standard fields (Title, Password, UserName, URL, Notes) are excluded — only custom fields are included.

### Bulk loading secrets

Use `kpBulk()` with `@setValuesBulk` to fetch the Password field from all entries under a group:

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# @setValuesBulk(kpBulk(Production), createMissing=true)
# ---

# These will be populated from entries under the "Production" group
DB_PASSWORD=
API_KEY=
```

```env-spec title=".env.schema"
# Load all entries from the database root
# @setValuesBulk(kpBulk())

# Load from a specific group
# @setValuesBulk(kpBulk("Services/APIs"))

# With a named instance
# @setValuesBulk(kpBulk(prod, Production))
```

Entry paths in the JSON output are sanitized to valid env var names (uppercased, non-alphanumeric characters replaced with underscores).

---

## Reference

### Root decorators

#### `@initKeePass()`

Initialize a KeePass plugin instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbPath` | string | yes | Path to the `.kdbx` database file |
| `password` | string | yes | Master password (typically from an env var like `$KP_PASSWORD`) |
| `keyFile` | string | no | Path to a key file for additional authentication |
| `useCli` | boolean | no | Use `keepassxc-cli` instead of reading the file directly (default: `false`). Can be dynamic, e.g. `useCli=forEnv(dev)` |
| `id` | string | no | Instance identifier for multiple databases (defaults to `_default`) |

### Data types

#### `kdbxPassword`

A sensitive string type for KeePass database master passwords. Validates that the value is a non-empty string.

### Resolver functions

#### `kp()`

Fetch a single entry field from a KeePass database.

**Signatures:**
- `kp()` — infer entry name from key, read Password field
- `kp(entryPath)` — read Password field
- `kp("entryPath#Attribute")` — read a specific attribute
- `kp("#Attribute")` — infer entry name from key, read a specific attribute
- `kp(entryPath, attribute=X)` — read a specific attribute (named param)
- `kp(instanceId, entryPath)` — read from a named database instance
- `kp(entryPath, customAttributesObj=true)` — return all custom fields as a JSON object

**Returns:** The field value as a string, or a JSON object string when `customAttributesObj=true`.

#### `kpBulk()`

Fetch the Password field from all entries under a group as a JSON map. Intended for use with `@setValuesBulk`.

**Signatures:**
- `kpBulk()` — load all entries from the database root
- `kpBulk(groupPath)` — load entries under a specific group
- `kpBulk(instanceId, groupPath)` — load from a named instance

**Returns:** JSON string of `{ "ENTRY_NAME": "password", ... }` pairs. Entry paths are sanitized to valid env var names.

---

## Troubleshooting

### Invalid credentials
- Check that the database password is correct
- If using a key file, verify the path is correct and the file matches the database

### Entry not found
- Entry paths are case-sensitive
- Use forward slashes to separate groups: `"Group/SubGroup/Entry"`
- In CLI mode, list entries with: `keepassxc-cli ls <database.kdbx>`

### `keepassxc-cli` not found (CLI mode only)
- Install KeePassXC which includes the CLI (see [Prerequisites](#prerequisites-for-cli-mode))
- Ensure `keepassxc-cli` is in your `PATH`

### Database file not found
- Check the `dbPath` value — it's resolved relative to the working directory
- Use an absolute path if needed

## Resources

- [KeePassXC](https://keepassxc.org/) — cross-platform KeePass-compatible password manager
- [KeePass](https://keepass.info/) — original KeePass Password Safe
- [KDBX format](https://keepass.info/help/kb/kdbx.html) — KeePass database format specification
- [kdbxweb](https://github.com/keeweb/kdbxweb) — JavaScript KDBX reader library
