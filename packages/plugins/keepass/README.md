# @varlock/keepass-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/keepass-plugin.svg)](https://www.npmjs.com/package/@varlock/keepass-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/keepass-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [KeePass](https://keepass.info/) / [KeePassXC](https://keepassxc.org/) databases (KDBX 4.0) into your configuration.

## Features

- **KDBX 4.0 support** - Reads KeePass database files directly via [kdbxweb](https://github.com/nicolo-ribaudo/nicolo-ribaudo/keeweb/kdbxweb)
- **KeePassXC CLI integration** - Use `keepassxc-cli` for development workflows
- **Key file support** - Authenticate with password + optional key file
- **Custom attributes** - Read any entry field (Password, UserName, URL, Notes, or custom)
- **Bulk loading** with `kpBulk()` via `@setValuesBulk` to load all entries in a group
- **Multiple instances** for accessing different databases
- **Batched CLI reads** - Concurrent CLI calls are parallelized within a time window
- **Helpful error messages** with resolution tips

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

### File mode (production)

In file mode (the default), the plugin opens and reads `.kdbx` files directly using the [kdbxweb](https://github.com/nicolo-ribaudo/nicolo-ribaudo/keeweb/kdbxweb) library. No external CLI is needed.

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# ---
```

### CLI mode (development)

When `useDesktopApp=true`, the plugin uses `keepassxc-cli` to read entries. This is useful during development when you want to leverage KeePassXC's system integration (e.g., YubiKey, Windows Hello).

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD, useDesktopApp=true)
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

Once initialized, use the `kp()` resolver function to fetch secrets.

### Basic usage

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# ---

# Fetch password from entry at "Database/production"
DB_PASSWORD=kp("Database/production")

# Fetch a different attribute (default is "Password")
DB_USER=kp("Database/production", attribute="UserName")
DB_URL=kp("Database/production", attribute="URL")

# Read a custom string field
API_KEY=kp("Services/stripe", attribute="SecretKey")
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

### Bulk loading secrets

Use `kpBulk()` with `@setValuesBulk` to fetch all entries under a group:

```env-spec title=".env.schema"
# @plugin(@varlock/keepass-plugin)
# @initKeePass(dbPath="./secrets.kdbx", password=$KP_PASSWORD)
# @setValuesBulk(kpBulk("Production"))
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
# @setValuesBulk(kpBulk(prod, "Production"))

# Fetch a non-password attribute for all entries
# @setValuesBulk(kpBulk("Users", attribute="UserName"))
```

---

## Reference

### Root decorators

#### `@initKeePass()`

Initialize a KeePass plugin instance.

**Parameters:**
- `dbPath: string` - **(required)** Path to the `.kdbx` database file
- `password: string` - **(required)** Master password for the database (typically from an env var like `$KP_PASSWORD`)
- `keyFile?: string` - Path to a key file for additional authentication
- `useDesktopApp?: boolean` - When `true`, uses `keepassxc-cli` instead of reading the file directly (default: `false`)
- `id?: string` - Instance identifier for multiple databases (defaults to `_default`)

### Data types

#### `kdbxPassword`

A sensitive string type for KeePass database master passwords. Validates that the value is a non-empty string.

### Resolver functions

#### `kp()`

Fetch a single entry field from a KeePass database.

**Signatures:**
- `kp(entryPath)` - Fetch the Password field from an entry
- `kp(entryPath, attribute="UserName")` - Fetch a specific attribute
- `kp(instanceId, entryPath)` - Fetch from a specific database instance

**Returns:** The value of the requested field as a string.

#### `kpBulk()`

Fetch all entries under a group as a JSON map. Intended for use with `@setValuesBulk`.

**Signatures:**
- `kpBulk()` - Load all entries from the database root
- `kpBulk(groupPath)` - Load entries under a specific group
- `kpBulk(instanceId, groupPath)` - Load from a named instance
- `kpBulk(groupPath, attribute="UserName")` - Load a specific attribute for all entries

**Returns:** JSON string of `{ "entryPath": "fieldValue", ... }` pairs.

---

## How it works

### File mode

The plugin uses [kdbxweb](https://github.com/nicolo-ribaudo/nicolo-ribaudo/keeweb/kdbxweb) to parse KDBX 4.0 files directly in-process:

1. Reads the `.kdbx` file from disk
2. Decrypts using the master password (and optional key file)
3. Navigates the group/entry tree to find the requested entry
4. Returns the requested field (Password, UserName, etc.)

The database is opened once and cached for the duration of a resolution session.

### CLI mode

When `useDesktopApp=true`, the plugin shells out to `keepassxc-cli`:

1. Concurrent reads within a 50ms window are collected into a batch
2. Each entry is fetched via `keepassxc-cli show --attributes <attr> --quiet <db> <entry>`
3. The database password is passed via stdin
4. All reads in a batch execute in parallel for performance

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

- [KeePassXC](https://keepassxc.org/) - Cross-platform KeePass-compatible password manager
- [KeePass](https://keepass.info/) - Original KeePass Password Safe
- [KDBX format](https://keepass.info/help/kb/kdbx.html) - KeePass database format specification
- [kdbxweb](https://github.com/nicolo-ribaudo/nicolo-ribaudo/keeweb/kdbxweb) - JavaScript KDBX reader library
