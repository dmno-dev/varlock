# @varlock/azure-key-vault-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/azure-key-vault-plugin.svg)](https://www.npmjs.com/package/@varlock/azure-key-vault-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/azure-key-vault-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [Azure Key Vault](https://azure.microsoft.com/en-us/products/key-vault) into your configuration.

## Features

- **Zero-config authentication** - Just provide your vault URL, authentication happens automatically
- **Managed Identity support** - No credentials needed for Azure-hosted apps (App Service, Container Instances, VMs, Functions, AKS)
- **Azure CLI authentication** - Works seamlessly with `az login` for local development
- **Auto-infer secret names** from environment variable names (e.g., `DATABASE_URL` → `database-url`)
- Support for service principal credentials (for non-Azure environments)
- Support for versioned secrets
- Automatic token caching and renewal
- Lightweight implementation using REST API (47 KB bundle, no heavy Azure SDK dependencies)

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly 
```bash
npm install @varlock/azure-key-vault-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin)
# ---
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/azure-key-vault-plugin@1.2.3)
# ---
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initAzure` root decorator.

### Automatic auth

For most use cases, you only need to provide the vault URL:

```env-spec
# @plugin(@varlock/azure-key-vault-plugin)
# @initAzure(vaultUrl="https://my-vault.vault.azure.net/")
# ---
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

# @type=azureTenantId @sensitive
AZURE_TENANT_ID=

# @type=azureClientId @sensitive
AZURE_CLIENT_ID=

# @type=azureClientSecret @sensitive
AZURE_CLIENT_SECRET=
```

You would then need to inject these env vars using your CI/CD system.

### Authentication Priority

The plugin tries authentication methods in this order:
1. **Service Principal** - If all three credentials (`tenantId`, `clientId`, `clientSecret`) are provided and non-empty
2. **Managed Identity** - Automatically used when running on Azure infrastructure
3. **Azure CLI** - Falls back to `az login` for local development

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

# Versioned secrets
API_KEY_V1=azureSecret("api-key@abc123def456")

# If using multiple named vault instances
PROD_SECRET=azureSecret(prod, "database-url")
DEV_SECRET=azureSecret(dev, "database-url")
```

---

## Reference

### Root decorators

#### `@initAzure()`

Initialize an Azure Key Vault plugin instance.

**Parameters:**

- `vaultUrl: string` (required) - Azure Key Vault URL (e.g., `https://my-vault.vault.azure.net/`)
- `tenantId?: string` - Azure AD tenant ID (directory ID)
- `clientId?: string` - Service principal application (client) ID
- `clientSecret?: string` - Service principal client secret (password)
- `id?: string` - Instance identifier for multiple vaults (defaults to `_default`)

### Functions
#### `azureSecret()`

Fetch a secret from Azure Key Vault.

**Signatures:**

- `azureSecret()` - Auto-infers secret name from variable name (`DATABASE_URL` → `database-url`)
- `azureSecret(secretName)` - Fetch by explicit secret name
- `azureSecret(instanceId, secretName)` - Fetch from a specific vault instance

**Secret Name Formats:**

- Latest version: `"my-secret"`
- Specific version: `"my-secret@abc123def456"`

### Data Types

- `azureTenantId` - Azure AD tenant ID (UUID format, sensitive)
- `azureClientId` - Service principal application ID (UUID format, sensitive)
- `azureClientSecret` - Service principal client secret (sensitive)

---

### Azure Setup

### Required Permissions

Your managed identity, service principal, or user needs one of:

- **Access Policy**: "Get" permission for secrets
- **RBAC**: "Key Vault Secrets User" role

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

### Permission denied
- Check your RBAC role: `az role assignment list --assignee <your-id> --scope <vault-scope>`
- Or check access policies: `az keyvault show --name my-vault --query properties.accessPolicies`

### Authentication failed
- **Local dev:** Run `az login` and ensure your env vars (`AZURE_TENANT_ID`, etc.) are empty
- **Azure-hosted apps:** Verify Managed Identity is enabled and has Key Vault permissions
- **Other environments:** Verify service principal credentials are correct and properly injected
