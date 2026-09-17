# @varlock/azure-app-configuration-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/azure-app-configuration-plugin.svg)](https://npmx.dev/package/@varlock/azure-app-configuration-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/azure-app-configuration-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that loads settings from [Azure App Configuration](https://learn.microsoft.com/azure/azure-app-configuration/overview).

## Installation

```bash
npm install @varlock/azure-app-configuration-plugin
```

```env-spec title=".env.schema"
# @plugin(@varlock/azure-app-configuration-plugin)
```

Without a `package.json`, register an explicit version:

```env-spec title=".env.schema"
# @plugin(@varlock/azure-app-configuration-plugin@0.1.0)
```

## Authentication

Use a store endpoint with Azure's default credential chain. This supports managed identity in Azure and Azure CLI credentials from `az login` during local development.

```env-spec
# @initAzureAppConfiguration(endpoint="https://my-store.azconfig.io")
```

You can provide `tenantId`, `clientId`, and `clientSecret` together for an explicit service principal, or use an access key connection string:

```env-spec
# @initAzureAppConfiguration(connectionString=$AZURE_APPCONFIG_CONNECTION_STRING)
# ---
# @type=azureAppConfigurationConnectionString
AZURE_APPCONFIG_CONNECTION_STRING=
```

The identity needs the **App Configuration Data Reader** role on the store.

## Reading settings

`azureAppConfig()` reads an unlabeled setting whose key matches the environment variable name. Pass a key and optional label for other settings.

```env-spec
DATABASE_URL=azureAppConfig()
API_URL=azureAppConfig("services:api:url", label=production)
```

Set `defaultLabel` once when an environment uses the same label for every lookup:

```env-spec
# @initAzureAppConfiguration(
#   endpoint="https://my-store.azconfig.io",
#   defaultLabel=production
# )
```

## Bulk loading

Use `azureAppConfigBulk()` with `@setValuesBulk` to load multiple settings. Filters use Azure App Configuration's key and label filter syntax.

```env-spec
# @initAzureAppConfiguration(endpoint="https://my-store.azconfig.io")
# @setValuesBulk(
#   azureAppConfigBulk(keyFilter="app:*", labelFilter=production, trimKeyPrefix="app:"),
#   format=json
# )
# ---
DATABASE_URL=
API_HOST=
```

`defaultKeyFilter`, `defaultLabel`, and `trimKeyPrefix` can also be set on `@initAzureAppConfiguration()`. Without a label, bulk loading selects only unlabeled settings.

## Multiple stores

Initialize named instances and pass the instance ID as the first positional argument:

```env-spec
# @initAzureAppConfiguration(id=dev, endpoint="https://dev.azconfig.io")
# @initAzureAppConfiguration(id=prod, endpoint="https://prod.azconfig.io")
# ---
DEV_API_URL=azureAppConfig(dev, "API_URL")
PROD_API_URL=azureAppConfig(prod, "API_URL")
```

For bulk loading, use `azureAppConfigBulk(prod, keyFilter="app:*")`.

## Reference

### `@initAzureAppConfiguration()`

- `endpoint?: string`: App Configuration endpoint. Required unless `connectionString` is set.
- `connectionString?: string`: App Configuration access key connection string. Required unless `endpoint` is set.
- `tenantId?: string`: Microsoft Entra tenant ID. Must be used with `clientId` and `clientSecret`.
- `clientId?: string`: Service principal client ID.
- `clientSecret?: string`: Service principal client secret.
- `defaultLabel?: string`: Label used when a resolver does not specify one.
- `defaultKeyFilter?: string`: Key filter used by `azureAppConfigBulk()`.
- `trimKeyPrefix?: string`: Prefix removed from keys returned by `azureAppConfigBulk()`.
- `cacheTtl?: string | number`: Cache resolved values for the provided TTL.
- `allowInsecureConnection?: boolean`: Allow HTTP endpoints. Use only for local emulators and tests.
- `id?: string`: Instance ID used when configuring multiple stores.

### `azureAppConfig()`

- `azureAppConfig()`: Read the setting matching the config item key.
- `azureAppConfig(key)`: Read an explicit key.
- `azureAppConfig(instanceId, key)`: Read from a named store.
- `label=`: Override the instance's default label.

### `azureAppConfigBulk()`

- `azureAppConfigBulk()`: Read settings using the instance defaults.
- `azureAppConfigBulk(instanceId)`: Read from a named store.
- `keyFilter=`: Override the key filter.
- `labelFilter=`: Override the label filter.
- `trimKeyPrefix=`: Override the prefix removed from returned keys.

Azure Key Vault references and feature flags are returned in their stored App Configuration representation. This plugin does not dereference Key Vault secrets or evaluate feature flags.
