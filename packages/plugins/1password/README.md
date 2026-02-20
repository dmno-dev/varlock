# @varlock/1password-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/1password-plugin.svg)](https://www.npmjs.com/package/@varlock/1password-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/1password-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [1Password](https://1password.com/) into your configuration.

## Features

- **Service account authentication** for CI/CD and production environments
- **Desktop app authentication** for local development (with biometric unlock support)
- **Secret references** using 1Password's standard `op://` format
- **Bulk-load environments** with `opLoadEnvironment()` via `@setValuesBulk`
- **Multiple vault support** for different environments and access levels
- **Multiple instances** for connecting to different accounts or vaults
- Compatible with any 1Password account type (personal, family, teams, business)
- Comprehensive error handling with helpful tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/1password-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/1password-plugin)
# ---
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/1password-plugin@1.2.3)
# ---
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initOp` root decorator.

### Service account setup (for deployed environments)

For deployed environments (CI/CD, production, etc), you'll need a service account token:

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN)
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=
```

**How to create a service account:**

1. Navigate to your 1Password web interface
2. Go to **Service Accounts** → Create a new service account
3. Grant access to necessary vault(s)
4. Copy the service account token (displayed only once!)
5. Set the token in your deployed environments using your platform's env var management

:::note
Vault access rules cannot be edited after creation. If your vault setup changes, you'll need to create a new service account.
:::

### Desktop app auth (for local dev)

During local development, you can use the 1Password desktop app instead of a service account:

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=true, account=acmeco)
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=
```

**Setup requirements:**

1. Install the `op` CLI: [Installation guide](https://developer.1password.com/docs/cli/get-started/)
2. Enable desktop app + CLI integration in 1Password settings
3. Specify your account shorthand (optional but recommended)
   - Run `op account list` to see available accounts
   - The shorthand is the subdomain of your `x.1password.com` sign-in address

When enabled, if the service account token is empty, the plugin will use the desktop app for authentication. With biometric unlock enabled, this provides a secure and convenient development experience.

:::note
Keep in mind that this method connects as _YOU_ who likely has more access than a tightly scoped service account. Consider only enabling this for non-production secrets.
:::

### Multiple instances

If you need to connect to multiple accounts or vault configurations, register multiple named instances:

```env-spec
# @initOp(id=notProd, token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# @initOp(id=prod, token=$OP_TOKEN_PROD, allowAppAuth=false)
```

## Reading secrets

This plugin introduces the `op()` function to fetch secret values using 1Password secret references.

```env-spec title=".env.schema"
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=

# Fetch secrets using 1Password secret references
DB_PASS=op(op://my-vault/database-password/password)
API_KEY=op(op://api-vault/stripe/api-key)
```

**How to find a secret reference:**

In 1Password, click on the down arrow icon on any field and select `Copy Secret Reference`.

### Multiple instances

If using multiple plugin instances:

```env-spec
# @initOp(id=dev, token=$OP_TOKEN_DEV, allowAppAuth=true)
# @initOp(id=prod, token=$OP_TOKEN_PROD, allowAppAuth=false)
# ---

DEV_ITEM=op(dev, op://vault-name/item-name/field-name)
PROD_ITEM=op(prod, op://vault-name/item-name/field-name)
```

### Loading 1Password Environments

Use `opLoadEnvironment()` with `@setValuesBulk` to load all variables from a [1Password environment](https://developer.1password.com/docs/sdks/concepts/environments/) at once:

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# @setValuesBulk(opLoadEnvironment(your-environment-id))
# ---

# @type=opServiceAccountToken @sensitive
OP_TOKEN=

API_KEY=
DB_PASSWORD=
```

With a named instance:

```env-spec
# @initOp(id=prod, token=$OP_TOKEN_PROD, allowAppAuth=false)
# @setValuesBulk(opLoadEnvironment(prod, your-environment-id))
```

> **Note:** When using desktop app auth (`allowAppAuth`), the `op environment` command requires a beta version of the 1Password CLI (v2.33.0+). Download it from the [CLI release history](https://app-updates.agilebits.com/product_history/CLI2) (click "show betas"). Service account auth via the SDK does not have this requirement.

---

## Reference

### Root decorators

#### `@initOp()`

Initialize a 1Password plugin instance - setting up options and authentication. Can be called multiple times to set up different instances.

**Parameters:**

- `token?: string` - Service account token. Should be a reference to a config item of type `opServiceAccountToken`.
- `allowAppAuth?: boolean` - Enable authenticating using the local desktop app (defaults to `false`)
- `account?: string` - Limits the `op` CLI to connect to specific 1Password account (shorthand, sign-in address, account ID, or user ID)
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `op()`

Fetch an individual field using a 1Password secret reference.

**Signatures:**

- `op(secretReference)` - Fetch from default instance
- `op(instanceId, secretReference)` - Fetch from a specific instance

**Secret Reference Format:**

- Format: `op://vault-name/item-name/field-name`
- Example: `op://production/database/password`

#### `opLoadEnvironment()`

Load all variables from a 1Password environment. Intended for use with `@setValuesBulk`.

**Signatures:**

- `opLoadEnvironment(environmentId)` - Load from default instance
- `opLoadEnvironment(instanceId, environmentId)` - Load from a specific instance

**Parameters:**

- `environmentId: string` - The 1Password environment ID
- `instanceId?: string` - Instance identifier (static, when using multiple instances)

### Data Types

- `opServiceAccountToken` - 1Password service account token (sensitive, validated format)

---

## 1Password Setup

### Vault Organization

If your secrets live in a vault with other sensitive data, create a new vault and move your secrets to it. **1Password's access system is based on vaults, not individual items**.

You can create multiple vaults to segment access to different environments, services, etc.

**Best practices:**
- Have a vault for highly sensitive production secrets
- Have another vault for everything else
- Grant team members access based on their needs
- Follow the [principle of least privilege](https://support.1password.com/business-security-practices/#access-management-and-the-principle-of-least-privilege)

### Create a Service Account

1. Log in to your 1Password web interface (can only be done in web)
2. Navigate to **Service Accounts** → **Create service account**
3. Grant access to necessary vault(s) during creation
4. Copy the service account token (shown only once!)
5. Save the token securely in another vault

:::note
Vault access rules cannot be edited after creation. If your setup changes, create a new service account.
:::

**Access toggle:**
Each vault has a toggle to disable service account access in general. It's on by default. [Learn more](https://developer.1password.com/docs/service-accounts/manage-service-accounts/#manage-access)

### Rate Limits

Note that [rate limits](https://developer.1password.com/docs/service-accounts/rate-limits/) vary by account type (personal, family, teams, business).

## Troubleshooting

### Secret not found
- Verify the secret reference format is correct: `op://vault/item/field`
- Check that the item exists in the specified vault
- Ensure the field name matches exactly

### Permission denied
- Verify your service account has access to the vault
- Check that the vault allows service account access (toggle in vault settings)
- For desktop app: ensure your user account has access to the vault

### Authentication failed (service account)
- Verify the service account token is correct
- Check if the token has been revoked
- Ensure the service account hasn't been disabled

### Desktop app authentication failed
- Ensure the `op` CLI is installed and in your `$PATH`
- Verify desktop app integration is enabled in 1Password settings
- Check that you specified the correct account (run `op account list`)
- Try running `op whoami` to debug CLI connection

### Rate limiting
- Check your account type's rate limits
- Consider implementing caching or reducing request frequency
- For high-volume use cases, consider upgrading to a business account

## Resources

- [1Password](https://1password.com/)
- [Service Accounts](https://developer.1password.com/docs/service-accounts/)
- [1Password CLI](https://developer.1password.com/docs/cli/)
- [Secret References](https://developer.1password.com/docs/cli/secret-references/)
- [Full documentation](https://varlock.dev/plugins/1password/)
