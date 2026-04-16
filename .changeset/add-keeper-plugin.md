---
"@varlock/keeper-plugin": patch
---

Add Keeper Security plugin for loading secrets from Keeper vaults via the Secrets Manager SDK. Supports fetching secrets by record UID, title, or Keeper notation syntax, with access to both standard and custom fields. Includes `keeperSmToken` data type for config token validation, `@initKeeper()` root decorator for initialization, and `keeper()` resolver function for secret retrieval.
