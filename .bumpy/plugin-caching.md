---
"@varlock/1password-plugin": minor
"@varlock/aws-secrets-plugin": minor
"@varlock/bitwarden-plugin": minor
"@varlock/google-secret-manager-plugin": minor
"@varlock/doppler-plugin": minor
"@varlock/infisical-plugin": minor
"@varlock/passbolt-plugin": minor
"@varlock/akeyless-plugin": minor
"@varlock/azure-key-vault-plugin": minor
"@varlock/hashicorp-vault-plugin": minor
"@varlock/keeper-plugin": minor
---

Add opt-in disk caching via the `cacheTtl` init param (e.g. `cacheTtl="1h"`, `cacheTtl=forever`; setting it to `false` or an empty string disables caching). Cache keys include a hash of the account-identifying instance config (account, region, project, environment, etc.) so projects pointing the same plugin at different backends can never read each other's cached values from the shared per-user cache.

Akeyless caches static secret values only — dynamic and rotated secrets are designed to change per fetch and are never cached.
