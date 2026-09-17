# @varlock/azure-key-vault-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/azure-key-vault-plugin.svg)](https://npmx.dev/package/@varlock/azure-key-vault-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/azure-key-vault-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that loads secrets from [Azure Key Vault](https://azure.microsoft.com/en-us/products/key-vault) and settings from [Azure App Configuration](https://azure.microsoft.com/en-us/products/app-configuration) into your configuration.

## Features

- **Zero-config authentication** - Just provide your vault URL, authentication happens automatically
- **Managed Identity support** - No credentials needed for Azure-hosted apps (App Service, Container Instances, VMs, Functions, AKS)
- **Azure CLI authentication** - Works seamlessly with `az login` for local development
- **Auto-infer secret names** from environment variable names (e.g., `DATABASE_URL` → `database-url`)
- **OIDC workload identity** - Authenticate from Vercel, GitHub Actions, and other platforms using federated credentials
- Support for service principal credentials (for non-Azure environments)
- Support for versioned secrets
- Extract individual values from JSON-encoded secrets
- **App Configuration settings** - Read single settings with `azureAppConfig()` or load many at once with `azureAppConfigBulk()`, with label support
- **Key Vault references** stored in App Configuration are dereferenced automatically
- Automatic token caching and renewal
- Lightweight implementation using the REST APIs (no Azure SDK dependencies)

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly 
```bash
npm install @varlock/azure-key-vault-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin)
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin@1.2.3)
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initAzure` root decorator. One instance can serve Key Vault, App Configuration, or both; at least one of `vaultUrl`, `appConfigEndpoint`, or `appConfigConnectionString` is required.

### Automatic auth

For most use cases, you only need to provide the vault URL and/or App Configuration endpoint:

```env-spec
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(vaultUrl="https://my-vault.vault.azure.net/")

# Or, with App Configuration as well
# @initAzure(
#   vaultUrl="https://my-vault.vault.azure.net/",
#   appConfigEndpoint="https://my-store.azconfig.io"
# )
```

**How this works:**

- **Local development:** Run `az login` → automatically uses Azure CLI credentials
- **Azure-hosted apps** (App Service, Container Instances, VMs, Functions, AKS): Enable Managed Identity → automatically authenticates (no secrets needed!)
- **Works everywhere** with zero configuration beyond the vault URL!

### Explicit credentials (For non-Azure environments)

If you're deploying outside of Azure (e.g., AWS, GCP, on-premises), wire up service principal credentials:

```env-spec
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(
#   vaultUrl="https://my-vault.vault.azure.net/",
#   tenantId=$AZURE_TENANT_ID,
#   clientId=$AZURE_CLIENT_ID,
#   clientSecret=$AZURE_CLIENT_SECRET
# )
# ---

# @type=azureTenantId
AZURE_TENANT_ID=

# @type=azureClientId
AZURE_CLIENT_ID=

# @type=azureClientSecret @sensitive @internal
AZURE_CLIENT_SECRET=
```

You would then need to inject these env vars using your CI/CD system.

> `@internal` keeps this credential out of your app's environment — varlock only uses it to fetch your secrets. If you need the credential at runtime for other purposes (e.g. via the Azure SDK), set `@internal=false` to keep it injected.

### OIDC workload identity (For Vercel, GitHub Actions, etc.)

If you're deploying on a platform that supports OIDC, you can authenticate without a client secret:

```env-spec
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(
#   vaultUrl="https://my-vault.vault.azure.net/",
#   tenantId=$AZURE_TENANT_ID,
#   clientId=$AZURE_CLIENT_ID
# )
# ---

# @type=azureTenantId
AZURE_TENANT_ID=

# @type=azureClientId
AZURE_CLIENT_ID=
```

When `tenantId` and `clientId` are provided without `clientSecret`, the plugin automatically uses the platform's OIDC token as a federated credential. You need to configure a federated credential on your Azure App Registration.

See the [OIDC Workload Identity guide](https://varlock.dev/guides/oidc/) for full setup instructions.

### Authentication Priority

The plugin tries authentication methods in this order:
1. **Service Principal** - If all three credentials (`tenantId`, `clientId`, `clientSecret`) are provided and non-empty
2. **OIDC Federated Credential** - If `tenantId` and `clientId` are provided without `clientSecret`, and an OIDC token is available
3. **Managed Identity** - Automatically used when running on Azure infrastructure
4. **Azure CLI** - Falls back to `az login` for local development

The same chain serves both Key Vault and App Configuration; tokens are requested and cached per service scope. App Configuration can alternatively use an access-key connection string (see below), which does not affect Key Vault requests.

### Multiple vaults
If you need to connect to multiple vaults, but never at the same time, you can alter the vault URL using a function:
```env-spec
# @initAzure(vaultUrl="https://my-vault-${ENV}.vault.azure.net/")
```

Or if in some cases you need to connect to both, or you want more explicit separation, you can register multiple named instances:
```env-spec
# @initAzure(id=prod, vaultUrl="https://my-vault-prod.vault.azure.net/")
# @initAzure(id=dev, vaultUrl="https://my-vault-dev.vault.azure.net/")
```


## Reading secrets

This plugin introduces a new function `azureSecret()` to fetch secret values from your vaults.

```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(vaultUrl="https://my-vault.vault.azure.net/")
# ---

# Auto-infer secret names (DATABASE_URL -> "database-url")
DATABASE_URL=azureSecret()
API_KEY=azureSecret()

# Explicit secret names
CUSTOM_SECRET=azureSecret("my-custom-secret-name")

# Versioned secrets - using @ suffix or named version= param
API_KEY_V1=azureSecret("api-key@abc123def456")
API_KEY_V2=azureSecret("api-key", version=abc123def456)

# Extract a value from a JSON-encoded secret - using # suffix or named key= param
# (e.g. the secret "db-creds" holds `{"username":"admin","password":"..."}`)
DB_PASSWORD=azureSecret("db-creds#password")
DB_USERNAME=azureSecret("db-creds", key=username)

# If using multiple named vault instances
PROD_SECRET=azureSecret(prod, "database-url")
DEV_SECRET=azureSecret(dev, "database-url")
```

## Reading App Configuration settings

Point the instance at your store with `appConfigEndpoint` (find it with `az appconfig show --name my-store --query endpoint -o tsv`). The identity needs the **App Configuration Data Reader** role on the store. `defaultLabel` selects a label for every lookup that does not name one.

```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(appConfigEndpoint="https://my-store.azconfig.io", defaultLabel="${APP_ENV}")
# ---

# Reads the setting named "DATABASE_URL" (key used verbatim, no kebab-case conversion)
DATABASE_URL=azureAppConfig()

# Explicit key and label
API_URL=azureAppConfig("services:api:url", label=production)

# Empty label forces the unlabeled setting even when defaultLabel is set
API_URL_BASE=azureAppConfig("services:api:url", label="")

# From a specific instance
API_URL_STAGING=azureAppConfig(staging, "services:api:url")
```

### Access-key connection string

If Entra ID auth is not an option for the store, pass a connection string instead of `appConfigEndpoint`. Requests are signed with HMAC-SHA256. This authenticates App Configuration only; Key Vault (including Key Vault references) still uses the Entra chain.

```env-spec
# @initAzure(appConfigConnectionString=$AZURE_APPCONFIG_CONNECTION_STRING)
# ---
# @type=azureAppConfigConnectionString
AZURE_APPCONFIG_CONNECTION_STRING=
```

### Bulk loading

`azureAppConfigBulk()` returns all matching settings as JSON for `@setValuesBulk()`. `keyFilter` defaults to `*`; `labelFilter` defaults to `defaultLabel`, or to unlabeled settings only. `trimKeyPrefix` strips a common prefix so keys line up with your config item names; keys that collide after trimming produce an error. Pagination is handled automatically.

```env-spec
# @setValuesBulk(azureAppConfigBulk(keyFilter="myapp:*", labelFilter=production, trimKeyPrefix="myapp:"), format=json)
# ---
DATABASE_URL=
API_HOST=
```

### Key Vault references and feature flags

Settings with content type `application/vnd.microsoft.appconfig.keyvaultref+json` point at a Key Vault secret. Both resolvers detect them and fetch the secret using the instance's Key Vault credentials. The reference may point at any vault the identity can read; `vaultUrl` does not need to be set.

Feature flags (`application/vnd.microsoft.appconfig.ff+json`) are returned as their JSON string and are not evaluated.

---

## Reference

### Root decorators

#### `@initAzure()`

Initialize an Azure plugin instance. At least one of `vaultUrl`, `appConfigEndpoint`, or `appConfigConnectionString` is required.

**Parameters:**

- `vaultUrl?: string` - Azure Key Vault URL (e.g., `https://my-vault.vault.azure.net/`); required for `azureSecret()`
- `appConfigEndpoint?: string` - Azure App Configuration endpoint (e.g., `https://my-store.azconfig.io`); required for `azureAppConfig()` / `azureAppConfigBulk()` unless `appConfigConnectionString` is set
- `appConfigConnectionString?: string` - App Configuration access-key connection string (`Endpoint=...;Id=...;Secret=...`); alternative to `appConfigEndpoint` plus Entra auth, App Configuration only
- `defaultLabel?: string` - label used by `azureAppConfig()` / `azureAppConfigBulk()` when none is given
- `authorityHost?: string` - Entra ID authority host for sovereign clouds (defaults to `https://login.microsoftonline.com`)
- `tenantId?: string` - Azure AD tenant ID (directory ID)
- `clientId?: string` - Service principal application (client) ID
- `clientSecret?: string` - Service principal client secret (password)
- `oidcToken?: string` - Explicit OIDC JWT token (auto-detected from platform if not provided)
- `cacheTtl?: string | number` - Cache resolved values for the provided TTL (`"5m"`, `"1h"`, `"1d"`, or `"forever"` to cache until manually cleared); set to `false` (or an empty string) to disable caching
- `id?: string` - Instance identifier for multiple vaults (defaults to `_default`)

### Functions
#### `azureSecret()`

Fetch a secret from Azure Key Vault.

**Signatures:**

- `azureSecret()` - Auto-infers secret name from variable name (`DATABASE_URL` → `database-url`)
- `azureSecret(secretName)` - Fetch by explicit secret name
- `azureSecret(instanceId, secretName)` - Fetch from a specific vault instance
- `azureSecret(secretName, version=versionId)` - Fetch a specific version
- `azureSecret(secretName, key=jsonKey)` - Extract a value from a JSON-encoded secret

**Named parameters:**

- `version=` - Secret version (alternative to `@version` suffix in the secret name)
- `key=` - Key to extract from a JSON-encoded secret value (alternative to `#key` suffix in the secret name)

**Secret Name Formats:**

- Latest version: `"my-secret"`
- Specific version: `"my-secret@abc123def456"` or `azureSecret("my-secret", version=abc123def456)`
- JSON key extraction: `"my-secret#password"` or `azureSecret("my-secret", key=password)`
- Combined: `"my-secret@abc123def456#password"`

#### `azureAppConfig()`

Fetch a single setting from Azure App Configuration. Key Vault references are dereferenced; feature flags are returned as JSON strings.

**Signatures:**

- `azureAppConfig()` - Uses the config item key verbatim as the setting key
- `azureAppConfig(key)` - Fetch by explicit key
- `azureAppConfig(instanceId, key)` - Fetch from a specific instance

**Named parameters:**

- `label=` - Setting label; overrides the instance `defaultLabel`. An empty string selects the unlabeled setting.

#### `azureAppConfigBulk()`

List settings and return them as a JSON object string for `@setValuesBulk(..., format=json)`.

**Signatures:**

- `azureAppConfigBulk()` - Default instance
- `azureAppConfigBulk(instanceId)` - Specific instance

**Named parameters:**

- `keyFilter=` - Key filter, `*` matches any characters (default `*`)
- `labelFilter=` - Label filter (default: `defaultLabel` if set, otherwise unlabeled settings only)
- `trimKeyPrefix=` - Prefix removed from each key before matching config items

### Data Types

- `azureTenantId` - Azure AD tenant ID (UUID format)
- `azureClientId` - Service principal application ID (UUID format)
- `azureClientSecret` - Service principal client secret (sensitive)
- `azureAppConfigConnectionString` - App Configuration access-key connection string (sensitive, internal)

---

### Azure Setup

### Required Permissions

Your managed identity, service principal, or user needs one of:

- **Access Policy**: "Get" permission for secrets
- **RBAC**: "Key Vault Secrets User" role

For App Configuration, the identity needs the **App Configuration Data Reader** role on the store (access-key connection strings need no role):

```bash
az role assignment create \
  --role "App Configuration Data Reader" \
  --assignee <principal-id-or-appId> \
  --scope $(az appconfig show --name my-store --query id -o tsv)
```

### Enable Managed Identity (Recommended for Azure-hosted apps)

Managed Identity is the Azure-native way to authenticate - no credentials needed!

**Enable system-assigned managed identity:**

```bash
# For App Service
az webapp identity assign --name my-app --resource-group my-rg

# For Container Instance
az container create --assign-identity --name my-container ...

# For VM
az vm identity assign --name my-vm --resource-group my-rg
```

**Grant Key Vault access to the identity:**

```bash
# Get the identity's principal ID
PRINCIPAL_ID=$(az webapp identity show --name my-app --resource-group my-rg --query principalId -o tsv)

# Grant RBAC role
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee $PRINCIPAL_ID \
  --scope /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault-name>

# Or set Access Policy
az keyvault set-policy \
  --name my-vault \
  --object-id $PRINCIPAL_ID \
  --secret-permissions get
```

That's it! Your app will now automatically authenticate using Managed Identity.

### Create a Service Principal (For non-Azure environments)

```bash
# Create service principal
az ad sp create-for-rbac --name "varlock-keyvault-reader"

# Grant access (Access Policy)
az keyvault set-policy \
  --name my-vault \
  --spn <appId> \
  --secret-permissions get

# Or grant access (RBAC)
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee <appId> \
  --scope /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault-name>
```

### Find Your Key Vault URL

```bash
az keyvault show --name my-vault --query properties.vaultUri -o tsv
# Output: https://my-vault.vault.azure.net/
```

## Troubleshooting

### Secret not found
- Verify the secret exists: `az keyvault secret list --vault-name my-vault`
- Remember: Azure uses hyphens, not underscores (use `database-url` not `database_url`)

### Setting not found
- List settings: `az appconfig kv list --endpoint https://my-store.azconfig.io --auth-mode login`
- Check the label: unlabeled and labeled settings with the same key are different settings

### Permission denied
- Check your RBAC role: `az role assignment list --assignee <your-id> --scope <vault-scope>`
- Or check access policies: `az keyvault show --name my-vault --query properties.accessPolicies`
- For App Configuration, ensure the identity has the "App Configuration Data Reader" role on the store

### Authentication failed
- **Local dev:** Run `az login` and ensure your env vars (`AZURE_TENANT_ID`, etc.) are empty
- **Azure-hosted apps:** Verify Managed Identity is enabled and has Key Vault permissions
- **Other environments:** Verify service principal credentials are correct and properly injected
