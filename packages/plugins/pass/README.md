# @varlock/pass-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/pass-plugin.svg)](https://www.npmjs.com/package/@varlock/pass-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/pass-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [pass](https://www.passwordstore.org/) (the standard unix password manager) into your configuration.

## Features

- **Zero-config** - Works with your existing pass store out of the box
- **GPG-backed encryption** - Leverages pass's native GPG security model
- **Auto-infer entry paths** from environment variable names
- **Bulk loading** with `passBulk()` via `@setValuesBulk` to load all entries under a path
- **Multiple store instances** for accessing different pass stores
- **Name prefixing** with `namePrefix` option for scoped entry access
- **Custom store paths** via `storePath` option (overrides `PASSWORD_STORE_DIR`)
- **`allowMissing`** option for graceful handling of optional secrets
- **In-session caching** - Each entry is decrypted only once per resolution
- **Helpful error messages** with resolution tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly:
```bash
npm install @varlock/pass-plugin
```
And then register the plugin without any version number:
```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
```

Otherwise just set the explicit version number when you register it:
```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin@0.0.1)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Prerequisites

You must have `pass` installed on your system:

```bash
# macOS
brew install pass

# Ubuntu/Debian
sudo apt-get install pass

# Fedora/RHEL
sudo yum install pass

# Arch
pacman -S pass
```

Your password store must be initialized (`pass init "Your GPG Key ID"`). See the [pass documentation](https://www.passwordstore.org/) for setup details.

The plugin does **not** fail at load time if `pass` is not installed - it only fails when you actually try to access a secret.

## Setup

After registering the plugin, initialize it with the `@initPass` root decorator.

### Basic setup

For most use cases, no configuration is needed:

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass()
```

This uses the default `~/.password-store` directory and your existing GPG configuration.

### Custom store path

If your password store is in a non-standard location:

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass(storePath=/path/to/custom/store)
```

### Name prefixing

Use `namePrefix` to automatically prepend a path prefix to all entry lookups:

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass(namePrefix=production/app/)
# ---

# Fetches "production/app/DATABASE_PASSWORD"
DATABASE_PASSWORD=pass()
```

### Multiple instances

Access multiple password stores:

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass(id=personal)
# @initPass(id=team, storePath=/shared/team-store)
# ---

MY_TOKEN=pass(personal, "tokens/github")
SHARED_KEY=pass(team, "api-keys/stripe")
```

## Loading secrets

Once initialized, use the `pass()` resolver function to fetch secrets.

### Basic usage

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass()
# ---

# Auto-infer entry path from variable name
DATABASE_PASSWORD=pass()

# Explicit entry path
STRIPE_KEY=pass("services/stripe/live-key")

# Nested entries
DB_CREDS=pass("production/database/credentials")
```

When called without arguments, `pass()` uses the config item key as the entry path in the pass store.

### Handling optional secrets

Use `allowMissing` when a secret may not exist in the store:

```env-spec title=".env.schema"
# Won't error if the entry doesn't exist - returns empty string instead
OPTIONAL_KEY=pass("monitoring/datadog-key", allowMissing=true)
```

### Multiline entries

By default, `pass()` returns only the **first line** of the entry (the password), matching pass's own convention where the password lives on line 1 and metadata follows on subsequent lines. This is the same behavior as `pass -c` (copy to clipboard).

To retrieve the full multiline content, use `multiline=true`:

```env-spec title=".env.schema"
# Only returns the first line (the password)
DB_PASSWORD=pass("production/database")

# Returns all lines (password + metadata)
DB_FULL_ENTRY=pass("production/database", multiline=true)
```

Example entry (`pass show production/database`):
```
mysecretpassword
URL: https://db.example.com
Username: admin
Port: 5432
```

- `pass("production/database")` returns `mysecretpassword`
- `pass("production/database", multiline=true)` returns the full content

### Bulk loading secrets

Use `passBulk()` with `@setValuesBulk` to fetch all entries under a directory in your pass store in one go:

```env-spec title=".env.schema"
# @plugin(@varlock/pass-plugin)
# @initPass()
# @setValuesBulk(passBulk("services"))
# ---

# These will be populated from entries under services/ in the pass store
# e.g., services/STRIPE_KEY, services/DATABASE_URL
STRIPE_KEY=
DATABASE_URL=
```

`passBulk()` lists all entries under the given path prefix, fetches each one (first line only, matching the `pass()` default), and returns a JSON map of `{ "entryPath": "password", ... }`.

```env-spec title=".env.schema"
# Load everything from the store root
# @setValuesBulk(passBulk())

# Load from a specific subdirectory
# @setValuesBulk(passBulk("production/api"))

# With a named instance
# @setValuesBulk(passBulk(team, "shared"))
```

---

## Reference

### Root decorators

#### `@initPass()`

Initialize a pass plugin instance.

**Parameters:**
- `storePath?: string` - Custom password store path (overrides `PASSWORD_STORE_DIR`, defaults to `~/.password-store`)
- `namePrefix?: string` - Prefix automatically prepended to all entry paths
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Resolver functions

#### `pass()`

Fetch a secret from the pass store.

**Signatures:**
- `pass()` - Auto-infers entry path from variable name
- `pass(entryPath)` - Fetch by explicit entry path
- `pass(instanceId, entryPath)` - Fetch from a specific instance
- `pass(entryPath, allowMissing=true)` - Fetch with graceful missing handling
- `pass(entryPath, multiline=true)` - Fetch the full multiline content

**Returns:** The first line (password) of the pass entry by default, or the full content if `multiline=true`.

#### `passBulk()`

Fetch all entries under a directory in the pass store at once. Intended for use with `@setValuesBulk`.

Lists entries via `pass ls`, then fetches each one in parallel. Each entry returns the first line only (matching the `pass()` default).

**Signatures:**
- `passBulk()` - Load all entries from the store root
- `passBulk(pathPrefix)` - Load entries under a specific path prefix
- `passBulk(instanceId, pathPrefix)` - Load from a named instance with prefix

**Returns:** JSON string of `{ "entryPath": "firstLineValue", ... }` pairs.

---

## How it works

Under the hood, the plugin:

1. Executes `pass show <path>` as a subprocess for each secret
2. Leverages your existing GPG agent for passphrase caching (you may be prompted for your GPG passphrase on first access)
3. Caches decrypted values in memory for the duration of a single resolution session (no secrets are persisted)
4. For bulk operations, lists entries with `pass ls` and fetches them in parallel

Since the plugin delegates entirely to the `pass` CLI, it respects all of your existing GPG and pass configuration, including:
- GPG agent passphrase caching
- Multiple GPG key recipients
- Git-backed password stores
- Custom `PASSWORD_STORE_DIR` settings

## Troubleshooting

### `pass` command not found
- Install pass using your system package manager (see [Prerequisites](#prerequisites))
- Ensure `pass` is in your `PATH`

### Entry not found
- Verify the entry exists: `pass show <path>`
- List available entries: `pass ls`
- Check for typos in the entry path
- If using `namePrefix`, remember it's prepended automatically

### GPG decryption failed
- Ensure your GPG key is available: `gpg --list-keys`
- Start the GPG agent: `gpgconf --launch gpg-agent`
- You may need to enter your GPG passphrase

### Password store not initialized
- Run `pass init "Your GPG Key ID"` to initialize the store
- See `pass init --help` for details

## Resources

- [pass - The Standard Unix Password Manager](https://www.passwordstore.org/)
- [pass man page](https://git.zx2c4.com/password-store/about/)
- [GPG documentation](https://gnupg.org/documentation/)
