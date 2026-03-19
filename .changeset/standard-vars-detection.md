---
"varlock": minor
"@varlock/aws-secrets-plugin": patch
"@varlock/1password-plugin": minor
"@varlock/bitwarden-plugin": patch
"@varlock/google-secret-manager-plugin": patch
"@varlock/infisical-plugin": patch
"@varlock/azure-key-vault-plugin": patch
---

general cleanup and standardization of plugins

feat: add `standardVars` plugin property for automatic env var detection warnings

Plugins can now declaratively set `plugin.standardVars` to define well-known env vars they use. The loading infrastructure automatically checks for these vars in the environment and shows non-blocking warnings (in pretty output or on failure) when they are detected but not wired into the schema or plugin decorator. Green highlighting indicates items that need to be added.
