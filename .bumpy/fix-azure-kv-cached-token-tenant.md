---
'@varlock/azure-key-vault-plugin': patch
---

Fixed Azure CLI token selection to respect the configured `tenantId`. With multiple `az login` accounts, a cached `vault.azure.net` token from another tenant could be picked and rejected by Key Vault with a misleading 401 ("token expired or invalid"). Cached tokens are now matched against the configured tenant, and the direct `az` fallback is scoped to it.
