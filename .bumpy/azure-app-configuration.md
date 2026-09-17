---
"@varlock/azure-key-vault-plugin": minor
---

Add Azure App Configuration support. `@initAzure()` now accepts `appConfigEndpoint`, `appConfigConnectionString`, and `defaultLabel` (with `vaultUrl` now optional), and two new resolvers load settings: `azureAppConfig()` reads a single setting by key and label, and `azureAppConfigBulk()` loads many settings at once for `@setValuesBulk()`. Key Vault references stored in App Configuration are dereferenced automatically. Also adds an `authorityHost` option for sovereign clouds.
