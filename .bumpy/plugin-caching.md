---
"@varlock/1password-plugin": minor
"@varlock/aws-secrets-plugin": minor
"@varlock/bitwarden-plugin": minor
"@varlock/google-secret-manager-plugin": minor
"@varlock/doppler-plugin": minor
"@varlock/infisical-plugin": minor
"@varlock/passbolt-plugin": minor
---

Add opt-in disk caching via the `cacheTtl` init param (e.g. `cacheTtl="1h"`, `cacheTtl=forever`; falsy values disable caching). Cache keys include a hash of the account-identifying instance config (account, region, project, environment, etc.) so projects pointing the same plugin at different backends can never read each other's cached values from the shared per-user cache.

Proton Pass is intentionally excluded — it reads from the local `pass-cli` vault, so there is no network round trip worth caching.
