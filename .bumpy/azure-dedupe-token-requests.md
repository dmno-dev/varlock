---
"@varlock/azure-key-vault-plugin": patch
---

Fetch the Azure access token once per service when resolving many secrets at once, run `az account get-access-token` without blocking other requests, and read the Azure CLI token cache from `AZURE_CONFIG_DIR` when set
